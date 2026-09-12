/**
 * State machine persisted in Postgres so a failed run resumes where it stopped:
 *   planned -> researched -> scripted -> verified -> [media + Claude final check] -> uploaded
 *   -> scheduled (Claude approved)  |  awaiting_approval (held, or one of your first N videos)
 * Media files live only on the runner; a failure in media redoes media from "verified".
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isDryRun, loadChannel, loadPlaybook, WORK, type ChannelConfig } from "../config";
import { closeDb, q, updateVideo } from "../lib/db";
import { createIssue } from "../lib/github";
import { usage } from "../lib/llm";
import { incident, log } from "../lib/log";
import { buildDescription, buildShortDescription, schedulePublic, upload } from "../stages/publish";
import { renderVideo, VERTICAL } from "../stages/render";
import { research } from "../stages/research";
import { finalReview, type Review } from "../stages/review";
import { pickSlot } from "../stages/schedule";
import { ensureIllustratable } from "../stages/feasibility";
import { forecast } from "../stages/forecast";
import { repairScript, reviseScript, writeScript } from "../stages/script";
import { makeThumbnail, safeThumbnailText } from "../stages/thumbnail";
import { pickTopic } from "../stages/topic";
import { verify } from "../stages/verify";
import { imageQa } from "../stages/image-qa";
import { replaceSceneImage, sceneImages, topicFallbacks } from "../stages/visuals";
import { synthesize } from "../stages/voice";
import type { Dossier, Script, Topic, Verification } from "../types";

const MAX_ATTEMPTS = 3;
const MAX_REVISIONS = 2;
const MAX_REPAIRS = 2; // rebuild-and-recheck rounds after the final check says hold

type VideoRow = {
  id: number; status: string; attempts: number; sub_niche: string; structure: string;
  topic: Topic; dossier: Dossier | null; script: Script | null; verification: Verification | null; repairs: number;
  youtube_id: string | null; short_youtube_id: string | null; assets: { review?: Review } | null; predicted_score: string | null;
  usage: Record<string, number>;
};

async function recentForVariety() {
  const rows = await q<{ title: string; script: Script }>(
    "select title, script from videos where script is not null and status not in ('failed','abandoned') order by id desc limit 10",
  );
  return rows.map((r) => ({ title: r.title, hook: r.script.scenes[0]?.narration ?? "" }));
}

async function handoff(cfg: ChannelConfig, video: VideoRow) {
  const script = video.script!;
  const youtubeId = video.youtube_id!;
  const review = video.assets?.review;
  const [{ n: released }] = await q<{ n: number }>("select count(*)::int as n from videos where status in ('scheduled','published')");
  const claudeApproves = cfg.approval.mode === "claude" && review?.decision === "publish" && review.overall >= cfg.approval.minScore;
  const warmup = released < cfg.approval.humanReviewFirst;

  if (claudeApproves && !warmup) {
    const { slot, publishAt } = await pickSlot(cfg, video.sub_niche);
    try {
      await schedulePublic(youtubeId, publishAt);
      if (video.short_youtube_id) await schedulePublic(video.short_youtube_id, new Date(publishAt.getTime() + 24 * 3600e3));
    } catch (e) {
      await incident("publish.schedule", e, video.id); // usually: API audit not passed yet -> publish manually
    }
    await updateVideo(video.id, { publish_slot: slot, publish_at: publishAt, status: "scheduled" });
    return log(`#${video.id} Claude approved (${review!.overall}/10) -> scheduled ${publishAt.toISOString()}`);
  }

  const repairs = (video.repairs ?? 0);
  const why = !review ? "no final review" : review.decision === "hold" ? `held after ${repairs} automatic repair round(s)` : review.overall < cfg.approval.minScore ? `score ${review.overall} < ${cfg.approval.minScore}` : cfg.approval.mode === "human" ? "approval mode = human" : `warm-up: your review for the first ${cfg.approval.humanReviewFirst} videos`;
  const ver = video.verification!;
  const issue = await createIssue(`Review: ${script.title}`, [
    `<!-- video:${video.id} -->`,
    `**Why you're seeing this:** ${why}`,
    `**Long video (private):** https://studio.youtube.com/video/${youtubeId}/edit`,
    video.short_youtube_id ? `**Short (private, publishes 24h after the long one):** https://studio.youtube.com/video/${video.short_youtube_id}/edit` : "",
    review ? `### Final check: ${review.decision.toUpperCase()} (${review.overall}/10, ${repairs} repair round(s))\n${review.noteForOwner}\n\n${review.issues.map((i) => `- [${i.severity}] ${i.what} -> ${i.fix}`).join("\n") || "_no issues_"}` : "",
    `### Standards review\n${ver.summary}`,
    `### Your call\n- Label **approve** -> scheduled at the next best slot.\n- Comment \`/title Better title\` first to change the title.\n- Comment the reason, then label **reject** -> the reason feeds the weekly learning job.`,
  ].filter(Boolean).join("\n\n"));
  await updateVideo(video.id, { issue_number: issue, status: "awaiting_approval" });
  log(`#${video.id} sent to you for review in issue #${issue} (${why})`);
}

let finished = false;
// A native addon (the voice model) can let the event loop drain and make Node exit silently with
// code 0 mid-run. This timer keeps the loop alive; the exit hook makes a silent death visible.
const keepAlive = setInterval(() => {}, 30_000);
process.on("exit", (code) => {
  if (!finished) {
    console.error(`\n❌ The run stopped early (exit code ${code}) without finishing a stage.`);
    console.error("   This is almost always the voice step. Check it on its own with:  npm run test:voice");
  }
});

async function main() {
  const cfg = loadChannel();
  const playbook = loadPlaybook();

  let [v] = await q<VideoRow>(
    "select * from videos where status in ('planned','researched','scripted','verified','uploaded') and attempts < $1 order by id limit 1",
    [MAX_ATTEMPTS],
  );

  if (!v) {
    // The cap counts videos that actually shipped — a held video must not cost you the week's slot.
    const [{ n: shipped }] = await q<{ n: number }>("select count(*)::int as n from videos where created_at > now() - interval '7 days' and status in ('scheduled','published','uploaded')");
    const [{ n: attempts }] = await q<{ n: number }>("select count(*)::int as n from videos where created_at > now() - interval '7 days' and status not in ('dry_run_complete')");
    const [{ n: waiting }] = await q<{ n: number }>("select count(*)::int as n from videos where status = 'awaiting_approval'");
    if (shipped >= cfg.maxVideosPerWeek && !isDryRun()) {
      return log(`weekly cap reached (${shipped}/${cfg.maxVideosPerWeek} shipped); skipping. Raise maxVideosPerWeek in config/channel.json to publish more.`);
    }
    // Guard against burning quota when every attempt keeps failing quality.
    if (attempts >= cfg.maxVideosPerWeek + 2 && !isDryRun()) {
      return log(`${attempts} production attempts this week for ${shipped} shipped; pausing until next week. Check: npm run why`);
    }
    if (waiting >= cfg.maxAwaitingApproval) return log(`${waiting} videos awaiting your review; skipping so nothing is wasted`);

    const { sub, structure, topic, outliers } = await pickTopic(cfg, process.env.FORCE_SUB_NICHE || undefined);
    [v] = await q<VideoRow>(
      "insert into videos (status, sub_niche, structure, topic) values ('planned', $1, $2, $3) returning *",
      [sub.id, structure.id, JSON.stringify({ ...topic, outliers })],
    );
    log(`#${v!.id} new topic: ${topic.chosen.workingTitle}`);
  }
  const video = v!;
  const structure = cfg.structures.find((s) => s.id === video.structure) ?? cfg.structures[0]!;
  let stage = video.status;

  try {
    if (stage === "planned") {
      video.dossier = await research(video.topic);
      await updateVideo(video.id, { dossier: video.dossier, status: (stage = "researched") });
      log(`#${video.id} researched: ${video.dossier.sources.length} sources`);
    }

    if (stage === "researched") {
      video.script = await writeScript({ cfg, playbook, structure, topic: video.topic, dossier: video.dossier!, recent: await recentForVariety() });
      await updateVideo(video.id, { script: video.script, title: video.script.title, status: (stage = "scripted") });
      log(`#${video.id} scripted: ${video.script.scenes.length} scenes + short`);
    }

    if (stage === "scripted") {
      const recentTitles = (await recentForVariety()).map((r) => r.title).filter((t) => t !== video.script!.title);
      let verification = await verify(video.script!, video.dossier!, recentTitles);
      for (let i = 0; i < MAX_REVISIONS && verification.verdict === "revise"; i++) {
        log(`#${video.id} revision ${i + 1}: ${verification.issues.length} issues`);
        video.script = await reviseScript({ cfg, playbook, script: video.script!, dossier: video.dossier!, verification });
        verification = await verify(video.script, video.dossier!, recentTitles);
      }
      video.verification = verification;
      if (verification.verdict !== "pass") {
        await updateVideo(video.id, { script: video.script, verification, status: "abandoned" });
        await incident("verify.abandoned", new Error(verification.summary), video.id);
        return log(`#${video.id} abandoned after review: ${verification.summary}`);
      }
      await updateVideo(video.id, { script: video.script, title: video.script!.title, verification, status: (stage = "verified") });
    }

    if (stage === "verified") {
      let script = video.script!;

      // Predict the ceiling before spending CPU. Repair once; abandon a topic that cannot carry a video.
      const history = await q<{ predicted: string; actual: string }>(
        "select predicted_score as predicted, actual_score as actual from videos where predicted_score is not null and actual_score is not null order by id desc limit 8",
      );
      const hist = history.map((h) => ({ predicted: Number(h.predicted), actual: Number(h.actual) }));
      // Check the archive before predicting: image availability dominates the final score.
      const feas = await ensureIllustratable({ cfg, script });
      script = feas.script;
      let fc = await forecast({ cfg, script, dossier: video.dossier!, history: hist, feasible: feas.feasible });
      log(`#${video.id} forecast: likely ${fc.likely}/10, ceiling ${fc.ceiling}/10 — ${fc.verdict} (weakest: ${fc.weakest.slice(0, 70)})`);

      if (fc.verdict === "repair" || fc.likely < cfg.approval.minScore) {
        script = await repairScript({ cfg, playbook, script, dossier: video.dossier!, issues: fc.fixes });
        fc = await forecast({ cfg, script, dossier: video.dossier!, history: hist, feasible: feas.feasible });
        log(`#${video.id} forecast after pre-repair: likely ${fc.likely}/10 — ${fc.verdict}`);
        await updateVideo(video.id, { script, title: script.title });
      }
      await updateVideo(video.id, { predicted_score: fc.likely });
      if (fc.verdict === "abandon" || fc.likely < cfg.approval.minScore - 1.5) {
        await updateVideo(video.id, { status: "abandoned" });
        await incident("forecast.abandoned", new Error(`predicted ${fc.likely}/10: ${fc.weakest}`), video.id);
        return log(`#${video.id} abandoned before production (predicted ${fc.likely}/10). Next run starts a new topic.`);
      }
      const dir = path.join(WORK, String(video.id));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "script.json"), JSON.stringify(script, null, 2));
      const used = new Set<string>();
      const fallbacks = topicFallbacks(video.topic.chosen.subject, cfg);

      // Network-bound image downloads run while the CPU-bound voice model works.
      log(`#${video.id} images (NASA) + voice (${cfg.voice.provider}) in parallel`);
      const [long, audio] = await Promise.all([
        sceneImages(cfg, script.scenes, path.join(dir, "images"), video.id, used, fallbacks),
        synthesize(cfg, script.scenes, path.join(dir, "audio")),
      ]);
      const shortAssets = cfg.makeShorts
        ? await Promise.all([
          sceneImages(cfg, script.short.scenes, path.join(dir, "short-images"), video.id, used, fallbacks),
          synthesize(cfg, script.short.scenes, path.join(dir, "short-audio")),
        ])
        : undefined;

      log(`#${video.id} image QA`);
      const qa = await imageQa({ cfg, dir, videoId: video.id, used, scenes: script.scenes, files: long.files, credits: long.credits, fallbacks });
      if (shortAssets) {
        await imageQa({ cfg, dir, videoId: video.id, used, scenes: script.short.scenes, files: shortAssets[0].files, credits: shortAssets[0].credits, rounds: 2, fallbacks });
      }
      log(`#${video.id} image QA replaced ${qa.rejected} image(s)`);

      log(`#${video.id} rendering`);
      const { videoPath, srtPath, timings } = await renderVideo({ scenes: script.scenes, images: long.files, audio, dir, seed: video.id });
      const shortOut = shortAssets
        ? await renderVideo({ scenes: script.short.scenes, images: shortAssets[0].files, audio: shortAssets[1], dir, seed: video.id + 1, size: VERTICAL, name: "short", burnCaptions: true })
        : undefined;
      // A thumbnail problem must never throw away a finished render.
      const thumbText = safeThumbnailText(script.thumbnailText, script.title, script.scenes.map((sc) => sc.narration).join(" "));
      if (thumbText !== script.thumbnailText) {
        await incident("thumbnail.text-rejected", new Error(`"${script.thumbnailText}" -> "${thumbText}" (word not in title or narration)`), video.id);
        script.thumbnailText = thumbText;
      }
      let thumbPath = await makeThumbnail(cfg, script.thumbnailQuery, thumbText, dir, used, long.files[0]!)
        .catch(async (e) => { await incident("thumbnail", e, video.id); return long.files[0]!; });
      const allCredits = [...long.credits];
      let description = buildDescription(script, script.scenes, timings, video.dossier!, allCredits);

      log(`#${video.id} final check`);
      let review = await finalReview({ dir, script, verification: video.verification!, description, videoPath, shortPath: shortOut?.videoPath, credits: long.credits });

      // Repair rather than discard: a held video is fixed and re-checked before anyone is asked to look at it.
      let repairs = video.repairs ?? 0;
      let rendered = { videoPath, srtPath, timings };
      while (review.decision === "hold" && repairs < MAX_REPAIRS) {
        repairs++;
        const serious = review.issues.filter((i) => i.severity !== "minor");
        const imageIssues = serious.filter((i) => i.area === "image" || i.area === "thumbnail");
        const scriptIssues = serious.filter((i) => i.area === "script" || i.area === "title");
        log(`#${video.id} repair ${repairs}/${MAX_REPAIRS}: ${imageIssues.length} image, ${scriptIssues.length} script`);

        // 1. swap the images the reviewer rejected (cheap, no re-voicing)
        for (const issue of imageIssues) {
          const idx = script.scenes.findIndex((sc) => sc.id === issue.sceneId);
          if (idx >= 0) {
            const got = await replaceSceneImage(cfg, script.scenes[idx]!, long.files[idx]!, used, video.id, fallbacks).catch(() => null);
            if (got) long.credits[idx] = got;
          }
        }

        // 2. rewrite only what the reviewer objected to, then re-voice just the changed scenes
        let audioChanged = false;
        if (scriptIssues.length) {
          const before = new Map(script.scenes.map((sc) => [sc.id, sc.narration]));
          const repaired = await repairScript({ cfg, playbook, script, dossier: video.dossier!, issues: serious });
          const changed = repaired.scenes.filter((sc) => before.get(sc.id) !== sc.narration);
          if (changed.length && changed.length <= repaired.scenes.length) {
            const fresh = await synthesize(cfg, changed, path.join(dir, `audio-r${repairs}`));
            for (const [i, sc] of repaired.scenes.entries()) {
              const f = fresh.find((x) => x.sceneId === sc.id);
              if (f) { audio[i] = f; audioChanged = true; }
              if (before.get(sc.id) !== sc.narration || script.scenes[i]?.imageQuery !== sc.imageQuery) {
                const got = await replaceSceneImage(cfg, sc, long.files[i]!, used, video.id, fallbacks).catch(() => null);
                if (got) long.credits[i] = got;
              }
            }
          }
          script = repaired;
        }

        // 3. re-render, re-thumbnail, re-check
        rendered = await renderVideo({ scenes: script.scenes, images: long.files, audio, dir, seed: video.id + repairs, name: `final-r${repairs}` });
        const newThumb = await makeThumbnail(cfg, script.thumbnailQuery,
          safeThumbnailText(script.thumbnailText, script.title, script.scenes.map((sc) => sc.narration).join(" ")),
          dir, used, long.files[0]!).catch(() => thumbPath);
        description = buildDescription(script, script.scenes, rendered.timings, video.dossier!, allCredits);
        review = await finalReview({ dir, script, verification: video.verification!, description, videoPath: rendered.videoPath, shortPath: shortOut?.videoPath, credits: long.credits });
        await updateVideo(video.id, { script, title: script.title, repairs, actual_score: review.overall, scene_timings: rendered.timings, assets: { images: allCredits, review, forecast: fc } });
        log(`#${video.id} after repair ${repairs}: ${review.decision} (${review.overall}/10)${audioChanged ? " [re-voiced]" : ""}`);
        thumbPath = newThumb;
        if (review.decision === "publish") break;
      }
      if (review.improvedTitle) script.title = review.improvedTitle;
      if (review.improvedDescriptionIntro) {
        script.description = review.improvedDescriptionIntro;
        description = buildDescription(script, script.scenes, timings, video.dossier!, allCredits);
      }
      allCredits.push(...(shortAssets?.[0].credits ?? []));
      await updateVideo(video.id, { script, title: script.title, scene_timings: timings, assets: { images: allCredits, review } });
      video.assets = { review };
      await updateVideo(video.id, { actual_score: review.overall });
      log(`#${video.id} final check: ${review.decision} (${review.overall}/10; predicted ${fc.likely})`);

      if (isDryRun()) {
        await updateVideo(video.id, { status: "dry_run_complete" });
        return log(`#${video.id} DRY RUN complete (${repairs} repair round(s)) -> ${rendered.videoPath}`);
      }

      const youtubeId = video.youtube_id ?? await upload(cfg, { videoPath: rendered.videoPath, thumbPath, srtPath: rendered.srtPath, title: script.title, description, tags: script.tags });
      await updateVideo(video.id, { youtube_id: youtubeId });
      video.youtube_id = youtubeId;
      if (shortOut && !video.short_youtube_id) {
        video.short_youtube_id = await upload(cfg, { ...shortOut, title: script.short.title, description: buildShortDescription(youtubeId, video.dossier!), tags: script.tags.slice(0, 5) });
        await updateVideo(video.id, { short_youtube_id: video.short_youtube_id });
      }
      await updateVideo(video.id, { status: (stage = "uploaded") });
      log(`#${video.id} uploaded (private): long ${youtubeId}${video.short_youtube_id ? `, short ${video.short_youtube_id}` : ""}`);
    }

    if (stage === "uploaded") await handoff(cfg, video);
  } catch (e) {
    await incident(`produce.${stage}`, e, video.id);
    await q("update videos set attempts = attempts + 1, status = case when attempts + 1 >= $2 then 'failed' else status end where id = $1", [video.id, MAX_ATTEMPTS]);
    process.exitCode = 1;
  } finally {
    const u = video.usage ?? {};
    await q("update videos set usage = $2::jsonb where id = $1", [video.id, JSON.stringify({
      llmCalls: (u.llmCalls ?? 0) + usage.calls,
      inputTokens: (u.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (u.outputTokens ?? 0) + usage.outputTokens,
      webSearches: (u.webSearches ?? 0) + usage.webSearches,
      estCostUsd: +((u.estCostUsd ?? 0) + usage.estCostUsd).toFixed(4),
    })]);
  }
}

main()
  .then(() => { finished = true; })
  .catch(async (e) => { finished = true; await incident("produce.fatal", e); process.exitCode = 1; })
  .finally(async () => { clearInterval(keepAlive); await closeDb(); });
