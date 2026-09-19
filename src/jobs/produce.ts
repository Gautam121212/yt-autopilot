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
import { isQuota, usage } from "../lib/llm";
import { incident, log } from "../lib/log";
import { withTimeout } from "../lib/time";
import { buildDescription, buildShortDescription, schedulePublic, upload } from "../stages/publish";
import { renderVideo, VERTICAL } from "../stages/render";
import { research } from "../stages/research";
import { finalReview, unreviewed, type Review } from "../stages/review";
import { pickSlot } from "../stages/schedule";
import { ensureIllustratable, MIN_FEASIBLE, MIN_TOPIC_VISUAL, probeTopicVisuals } from "../stages/feasibility";
import { forecast } from "../stages/forecast";
import { expandScript, punchUp, repairScript, reviseScript, stripUnsourced, writeScript } from "../stages/script";
import { makeThumbnail, safeThumbnailText } from "../stages/thumbnail";
import { pickTopic } from "../stages/topic";
import { verify } from "../stages/verify";
import { sceneQa, SCENE_BAR } from "../stages/scene-qa";
import { replaceSceneImage, sceneImages, topicFallbacks } from "../stages/visuals";
import { synthesize } from "../stages/voice";
import { MIN_WORDS, scriptWords, type Dossier, type Script, type Topic, type Verification } from "../types";

const MAX_ATTEMPTS = 3;
const MAX_REVISIONS = 2;
const MAX_REPAIRS = 2; // rebuild-and-recheck rounds after the final check says hold (cheap now: clips are cached)

/**
 * Self-imposed deadline. The runner kills the step at 75 minutes; finishing with an uploaded video
 * and one skipped repair always beats being killed with nothing to show for an hour of work.
 */
const DEADLINE_MIN = Number(process.env.PRODUCE_DEADLINE_MIN ?? 50);
/** A topic must average at least this across all six axes to be worth producing. */
const MIN_TOPIC_SCORE = Number(process.env.MIN_TOPIC_SCORE ?? 7.5);

/** Writes to the GitHub Actions run summary, so the decision is visible without reading logs. */
async function summary(lines: string[]) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  await fs.appendFile(f, `${lines.join("\n")}\n\n`).catch(() => {});
}
const startedAt = Date.now();
const minutesLeft = () => DEADLINE_MIN - (Date.now() - startedAt) / 60_000;

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
    await updateVideo(video.id, { status: "ready" });
    return log(`#${video.id} approved (${review!.overall}/10) -> added to the publish queue`);
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
  log("starting: checking the queue");

  let [v] = await q<VideoRow>(
    "select * from videos where status in ('planned','researched','scripted','verified','uploaded') and attempts < $1 order by id limit 1",
    [MAX_ATTEMPTS],
  );

  if (!v) {
    // The cap counts videos that actually shipped — a held video must not cost you the week's slot.
    const [{ n: shipped }] = await q<{ n: number }>("select count(*)::int as n from videos where created_at > now() - interval '7 days' and status in ('scheduled','published','uploaded')");
    // The runaway guard should count things that WASTED effort, not videos that were made and then
    // judged. A human rejecting a finished video means the pipeline worked; it must not block the week.
    const [{ n: wasted }] = await q<{ n: number }>(
      "select count(*)::int as n from videos where created_at > now() - interval '7 days' and status in ('failed','abandoned')",
    );
    const [{ n: waiting }] = await q<{ n: number }>("select count(*)::int as n from videos where status = 'awaiting_approval'");
    // Today's quota: the cron fires every few hours precisely because topic and script gates fail
    // often and cheaply. Once the day's video exists, stop — no point burning quota for nothing.
    const [{ n: todaysWins }] = await q<{ n: number }>(
      `select count(*)::int as n from videos
       where (created_at at time zone $1)::date = (now() at time zone $1)::date
         and status in ('ready','awaiting_publish','awaiting_approval','scheduled','published')`,
      [cfg.productionTimezone],
    );
    // FORCE exists to bypass the weekly FAILURE cap, not the day's target: once today's video
    // exists, a manual run should stop too, or the cron and the human fight each other.
    if (todaysWins >= cfg.videosPerDay && !isDryRun()) {
      return log(`today's video is already done (${todaysWins}/${cfg.videosPerDay} in ${cfg.productionTimezone}); nothing to do until tomorrow. Raise videosPerDay in config/channel.json to make more.`);
    }
    if (todaysWins) log(`${todaysWins}/${cfg.videosPerDay} done today — going again`);

    // The week being full is not a reason to stop: build a backlog so a bad week never empties the channel.
    const [{ n: backlog }] = await q<{ n: number }>("select count(*)::int as n from videos where status = 'ready'");
    if (shipped >= cfg.maxVideosPerWeek && backlog >= cfg.backlogTarget && !isDryRun()) {
      return log(`week is full (${shipped}/${cfg.maxVideosPerWeek}) and backlog is full (${backlog}/${cfg.backlogTarget}); nothing to do.`);
    }
    if (shipped >= cfg.maxVideosPerWeek) log(`week is full; producing for the backlog (${backlog}/${cfg.backlogTarget})`);
    // Guard against burning quota when every attempt keeps failing quality.
    const wasteCap = cfg.maxVideosPerWeek + cfg.backlogTarget + 4;
    if (wasted >= wasteCap && !isDryRun() && process.env.FORCE_PRODUCE !== "true") {
      return log(`${wasted} runs failed or were abandoned this week (cap ${wasteCap}); pausing so quota is not burned. ` +
        `Check \`npm run why\`, then re-run with FORCE_PRODUCE=true to override.`);
    }
    if (waiting >= cfg.maxAwaitingApproval) return log(`${waiting} videos awaiting your review; skipping so nothing is wasted`);

    log("picking a topic (demand search + model)");
    const picked = await withTimeout(
      pickTopic(cfg, process.env.FORCE_SUB_NICHE || undefined), 12 * 60_000, "topic selection",
    ).catch(async (e) => {
      // Never hang on topic choice: retry once without the YouTube demand search.
      await incident("topic.timeout", e);
      log("topic selection stalled — retrying without the demand search");
      process.env.SKIP_DEMAND_SEARCH = "true";
      return withTimeout(pickTopic(cfg, process.env.FORCE_SUB_NICHE || undefined), 8 * 60_000, "topic selection (retry)");
    });
    const { sub, structure, topic, outliers } = picked;
    const c = topic.chosen;
    const sc = c.scores;
    const avg = (sc.absurdity + sc.retellability + sc.curiosity + sc.evidence + sc.illustratability + sc.freshness) / 6;

    // Everything about this decision, visible in the run log and the workflow summary.
    const scoreLines = [
      `**${c.workingTitle}**`,
      "",
      `premise: ${c.premise}`,
      `funniest true detail: ${c.funniestDetail}`,
      "",
      "| axis | score | bar |",
      "|---|---|---|",
      `| absurdity | ${sc.absurdity} | 7 |`,
      `| retellability | ${sc.retellability} | 7 |`,
      `| curiosity | ${sc.curiosity} | 7 |`,
      `| evidence | ${sc.evidence} | 7 |`,
      `| illustratability | ${sc.illustratability} | 7 |`,
      `| freshness | ${sc.freshness} | 6 |`,
      `| **average** | **${avg.toFixed(1)}** | **${MIN_TOPIC_SCORE}** |`,
    ];
    log(`topic scores — absurdity ${sc.absurdity}, retell ${sc.retellability}, curiosity ${sc.curiosity}, evidence ${sc.evidence}, illustratability ${sc.illustratability}, freshness ${sc.freshness} → avg ${avg.toFixed(1)} (bar ${MIN_TOPIC_SCORE})`);

    if (avg < MIN_TOPIC_SCORE) {
      // Nothing has been written yet, so nothing is wasted and no row is created.
      await summary([...scoreLines, "", `❌ dropped: average ${avg.toFixed(1)} is below the ${MIN_TOPIC_SCORE} bar.`]);
      return log(`dropped "${c.workingTitle}" before research: average ${avg.toFixed(1)} < ${MIN_TOPIC_SCORE}. Next run picks a new topic.`);
    }

    // Can this story be filmed at all? Metadata-only probe, before any script credits.
    log(`checking whether the story can be filmed (${c.visualSubjects.length} subjects)`);
    const vis = await probeTopicVisuals(c.visualSubjects);
    log(`filmable: ${Math.round(vis.score * 100)}% — missing: ${vis.missing.join(", ") || "none"}`);
    if (vis.score < MIN_TOPIC_VISUAL) {
      await summary([...scoreLines, "",
        `❌ dropped: only ${Math.round(vis.score * 100)}% of its visual subjects exist in the stock libraries (bar ${Math.round(MIN_TOPIC_VISUAL * 100)}%).`,
        `missing: ${vis.missing.join(", ")}`]);
      return log(`dropped "${c.workingTitle}" before research: only ${Math.round(vis.score * 100)}% filmable. Next run picks a new topic.`);
    }
    await summary([...scoreLines, "", `✅ proceeding — ${Math.round(vis.score * 100)}% of its visual subjects exist in the stock libraries.`]);
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
      log(`#${video.id} researching`);
      video.dossier = await withTimeout(research(video.topic), 15 * 60_000, "research");
      await updateVideo(video.id, { dossier: video.dossier, status: (stage = "researched") });
      log(`#${video.id} researched: ${video.dossier.sources.length} sources`);
    }

    if (stage === "researched") {
      log(`#${video.id} writing the script`);
      video.script = await writeScript({ cfg, playbook, structure, topic: video.topic, dossier: video.dossier!, recent: await recentForVariety() });
      // ── CHEAP GATES FIRST ──────────────────────────────────────────────────────────────
      // Everything below here is a heavy call, so anything that can abandon the video must run
      // BEFORE them. Costing six heavy calls to then fail an 8% feasibility check is the exact
      // waste this ordering exists to prevent.

      // 1. Snap every image search onto the vetted subjects (free, no model call).
      const approved = video.topic.chosen.visualSubjects ?? [];
      if (approved.length) {
        const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
        const pool = approved.map((a) => ({ raw: a, n: norm(a) }));
        const nearest = (q: string) => {
          const qn = norm(q);
          const exact = pool.find((p) => p.n === qn);
          if (exact) return exact.raw;
          const overlap = pool
            .map((p) => ({ p, hits: p.n.split(" ").filter((w) => w.length > 3 && qn.includes(w)).length }))
            .sort((a, b) => b.hits - a.hits)[0];
          return overlap && overlap.hits > 0 ? overlap.p.raw : null;
        };
        let snapped = 0;
        for (const sc of video.script.scenes) {
          const fixed = nearest(sc.imageQuery);
          if (fixed && fixed !== sc.imageQuery) { sc.imageQuery = fixed; snapped++; }
          sc.altQueries = (sc.altQueries ?? []).map((q) => nearest(q) ?? q);
        }
        const offList = video.script.scenes.filter((sc) => !pool.some((p) => p.n === norm(sc.imageQuery)));
        log(`#${video.id} image searches: ${video.script.scenes.length - offList.length}/${video.script.scenes.length} on the approved list (snapped ${snapped})`);
        // Anything still off-list gets an approved subject assigned round-robin: the list was
        // already proven to exist, so this can only improve feasibility.
        for (const [k, sc] of offList.entries()) {
          sc.imageQuery = approved[k % approved.length]!;
          sc.altQueries = [approved[(k + 1) % approved.length]!, approved[(k + 2) % approved.length]!];
        }
      }

      // 2. Feasibility — a LIGHT call, and now the last gate before any heavy work.
      const early = await ensureIllustratable({ cfg, script: video.script, rounds: 1 });
      video.script = early.script;
      log(`#${video.id} image feasibility: ${Math.round(early.feasible * 100)}% (bar ${Math.round(MIN_FEASIBLE * 100)}%)`);
      if (early.feasible < MIN_FEASIBLE) {
        await updateVideo(video.id, { status: "abandoned" });
        await incident("feasibility.abandoned", new Error(`${Math.round(early.feasible * 100)}% findable before any heavy pass`), video.id);
        return log(`#${video.id} abandoned after ${Math.round(early.feasible * 100)}% feasibility — no heavy calls spent. Next run starts a new topic.`);
      }

      // ── HEAVY PASSES, only now that the video is worth them ────────────────────────────
      let draft: Script = video.script;
      for (let round = 1; round <= 2; round++) {
        const words = scriptWords(draft);
        if (words >= MIN_WORDS) break;
        log(`#${video.id} script is ${words} words — expanding (round ${round})`);
        const longer = await expandScript({ cfg, playbook, script: draft, dossier: video.dossier!, words })
          .catch(async (e): Promise<Script | null> => { await incident("expand", e, video.id); return null; });
        if (!longer) break;
        draft = longer;
      }
      video.script = draft;
      const finalWords = scriptWords(draft);
      log(`#${video.id} narration: ${finalWords} words (~${Math.round(finalWords / cfg.wordsPerMinute)} min)`);
      if (finalWords < MIN_WORDS) {
        await updateVideo(video.id, { status: "abandoned" });
        await incident("script.too-short", new Error(`${finalWords} words after 2 expand rounds (need ${MIN_WORDS})`), video.id);
        return log(`#${video.id} abandoned: only ${finalWords} words after expanding twice. Next run starts a new topic.`);
      }

      // A dedicated comedy pass: the single prompt that writes the facts cannot also find the voice.
      const punched = await punchUp({ cfg, script: video.script, dossier: video.dossier! }).catch(async (e) => {
        await incident("punch-up", e, video.id);
        return null;
      });
      if (punched) {
        video.script = punched;
        log(`#${video.id} comedy pass applied`);
      }
      await updateVideo(video.id, { script: video.script, title: video.script.title, status: (stage = "scripted") });
      log(`#${video.id} scripted: ${video.script.scenes.length} scenes + short`);
    }

    if (stage === "scripted") {
      log(`#${video.id} fact + policy check`);
      const recentTitles = (await recentForVariety()).map((r) => r.title).filter((t) => t !== video.script!.title);
      let verification = await verify(video.script!, video.dossier!, recentTitles);
      for (let i = 0; i < MAX_REVISIONS && verification.verdict === "revise"; i++) {
        log(`#${video.id} revision ${i + 1}: ${verification.issues.length} issues`);
        video.script = await reviseScript({ cfg, playbook, script: video.script!, dossier: video.dossier!, verification });
        verification = await verify(video.script, video.dossier!, recentTitles);
      }
      // Before giving up: if what remains is unsourced embellishment, delete it rather than the script.
      if (verification.verdict !== "pass" && verification.issues.some((i) => i.category === "factual")) {
        log(`#${video.id} stripping unsourced details rather than abandoning a working script`);
        const stripped = await stripUnsourced({
          cfg, playbook, script: video.script!, dossier: video.dossier!,
          issues: verification.issues.filter((i) => i.severity !== "minor").map((i) => ({ what: i.problem, fix: i.fix })),
        }).catch(() => null);
        if (stripped) {
          const after = await verify(stripped, video.dossier!, recentTitles);
          log(`#${video.id} after strip: ${after.verdict} (${after.issues.length} issues)`);
          if (after.verdict === "pass") { video.script = stripped; verification = after; }
        }
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
      // Feasibility already passed before the heavy passes; re-measure only to inform the forecast.
      const feas = await ensureIllustratable({ cfg, script, rounds: 0 });
      script = feas.script;
      let fc = await forecast({ cfg, script, dossier: video.dossier!, history: hist, feasible: feas.feasible });
      log(`#${video.id} forecast: likely ${fc.likely}/10, ceiling ${fc.ceiling}/10 — ${fc.verdict} (weakest: ${fc.weakest.slice(0, 70)})`);

      if (fc.verdict === "repair" || fc.likely < cfg.approval.minScore) {
        // Keep the best of: the original, a targeted repair, and one clean rewrite.
        // Patching a script can make it worse — measured, so never assume the repair wins.
        const candidates: { label: string; script: Script; fc: typeof fc }[] = [{ label: "original", script, fc }];

        const repaired = await repairScript({ cfg, playbook, script, dossier: video.dossier!, issues: fc.fixes }).catch(() => null);
        if (repaired) {
          const rfc = await forecast({ cfg, script: repaired, dossier: video.dossier!, history: hist, feasible: feas.feasible });
          log(`#${video.id} after targeted repair: likely ${rfc.likely}/10`);
          candidates.push({ label: "repair", script: repaired, fc: rfc });
        }

        // A fresh draft that knows what was wrong often beats patching the flawed one.
        const best = candidates.reduce((a, b) => (b.fc.likely > a.fc.likely ? b : a));
        if (best.fc.likely < cfg.approval.minScore && minutesLeft() > 30) {
          const rewritten = await writeScript({
            cfg, playbook, structure, topic: video.topic, dossier: video.dossier!,
            recent: await recentForVariety(),
            critique: `A reviewer rejected the previous draft of this video. Its weakest point: ${fc.weakest}. ` +
              `Specific faults: ${fc.fixes.map((f) => f.what).join("; ")}. Write a different draft that does not repeat them.`,
          }).catch(() => null);
          if (rewritten) {
            const wfc = await forecast({ cfg, script: rewritten, dossier: video.dossier!, history: hist, feasible: feas.feasible });
            log(`#${video.id} after full rewrite: likely ${wfc.likely}/10`);
            candidates.push({ label: "rewrite", script: rewritten, fc: wfc });
          }
        }

        const winner = candidates.reduce((a, b) => (b.fc.likely > a.fc.likely ? b : a));
        log(`#${video.id} keeping the "${winner.label}" draft (${winner.fc.likely}/10)`);
        script = winner.script;
        fc = winner.fc;
        await updateVideo(video.id, { script, title: script.title });
      }

      // THE SCRIPT BAR. A rendered video scores at best around what its script forecast, so a script
      // below this can only waste an hour of rendering. Repair is cheap; rendering is not.
      const bar = cfg.approval.minScriptScore;
      for (let attempt = 1; fc.likely < bar && attempt <= 2; attempt++) {
        log(`#${video.id} script at ${fc.likely}/10, below the ${bar} bar — repairing (${attempt}/2)`);
        const better = await repairScript({ cfg, playbook, script, dossier: video.dossier!, issues: fc.fixes }).catch(() => null);
        if (!better) break;
        const bfc = await forecast({ cfg, script: better, dossier: video.dossier!, history: hist, feasible: feas.feasible });
        if (bfc.likely > fc.likely) { script = better; fc = bfc; await updateVideo(video.id, { script, title: script.title }); }
        log(`#${video.id} after repair: ${fc.likely}/10`);
      }
      if (fc.likely < bar) {
        await updateVideo(video.id, { status: "abandoned", predicted_score: fc.likely });
        await incident("script.below-bar", new Error(`forecast ${fc.likely}/10 after repairs (bar ${bar}); weakest: ${fc.weakest}`), video.id);
        return log(`#${video.id} abandoned: script forecast ${fc.likely}/10 < ${bar}. Nothing was rendered. Next run starts a new topic.`);
      }
      log(`#${video.id} script cleared the bar at ${fc.likely}/10 — production begins`);
      await updateVideo(video.id, { predicted_score: fc.likely });
      const [{ n: abandonedRecently }] = await q<{ n: number }>(
        "select count(*)::int as n from videos where status = 'abandoned' and id < $1 and id >= $1 - 2", [video.id],
      );
      const forceThrough = abandonedRecently >= 2;
      if (forceThrough) {
        log(`#${video.id} ${abandonedRecently} topics abandoned in a row — producing this one anyway so the loop gets real data`);
      }
      if (!forceThrough && (fc.verdict === "abandon" || fc.likely < cfg.approval.minScore - 1.5)) {
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
        sceneImages(cfg, script.scenes, path.join(dir, "images"), video.id, used, fallbacks, { w: 1920, h: 1080 }),
        synthesize(cfg, script.scenes, path.join(dir, "audio")),
      ]);
      const shortAssets = cfg.makeShorts
        ? await Promise.all([
          sceneImages(cfg, script.short.scenes, path.join(dir, "short-images"), video.id, used, fallbacks, { w: 1080, h: 1920 }),
          synthesize(cfg, script.short.scenes, path.join(dir, "short-audio")),
        ])
        : undefined;

      // Per-scene gate: every scene must clear SCENE_BAR before the next one is judged.
      log(`#${video.id} scene-by-scene visual check (bar ${SCENE_BAR}/10)`);
      const qa = await sceneQa({ cfg, dir, videoId: video.id, used, scenes: script.scenes, files: long.files, credits: long.credits, fallbacks });
      log(`#${video.id} scenes passed: ${qa.passed}/${script.scenes.length} · replaced ${qa.replaced} image(s)${qa.failed.length ? ` · still weak: ${qa.failed.join(", ")}` : ""}`);
      if (qa.failed.length > Math.ceil(script.scenes.length * 0.25)) {
        // A quarter of the video looking wrong is not worth rendering, voicing or uploading.
        await updateVideo(video.id, { status: "abandoned" });
        await incident("scene-qa.abandoned", new Error(`${qa.failed.length}/${script.scenes.length} scenes below ${SCENE_BAR}: ${qa.failed.join(", ")}`), video.id);
        return log(`#${video.id} abandoned: ${qa.failed.length} scenes could not reach ${SCENE_BAR}/10. Next run starts a new topic.`);
      }
      if (shortAssets) {
        const sq = await sceneQa({ cfg, dir, videoId: video.id, used, scenes: script.short.scenes, files: shortAssets[0].files, credits: shortAssets[0].credits, fallbacks });
        log(`#${video.id} short scenes passed: ${sq.passed}/${script.short.scenes.length}`);
      }

      log(`#${video.id} rendering`);
      const captionsFor = (scs: { cardHeadline?: string }[]) =>
        scs.map((sc) => sc.cardHeadline?.trim() || undefined);
      const firstStill = (files: string[][]) =>
        files.flat().find((f) => !/\.(mp4|mov|webm)$/i.test(f)) ?? files.flat()[0]!;
      const { videoPath, srtPath, timings } = await renderVideo({
        scenes: script.scenes, images: long.files, audio, dir, seed: video.id,
        captions: captionsFor(script.scenes),
      });
      const shortOut = shortAssets
        ? await renderVideo({ scenes: script.short.scenes, images: shortAssets[0].files, audio: shortAssets[1], dir, seed: video.id + 1, size: VERTICAL, name: "short", burnCaptions: true })
        : undefined;
      // A thumbnail problem must never throw away a finished render.
      const thumbText = safeThumbnailText(script.thumbnailText, script.title, script.scenes.map((sc) => sc.narration).join(" "));
      if (thumbText !== script.thumbnailText) {
        await incident("thumbnail.text-rejected", new Error(`"${script.thumbnailText}" -> "${thumbText}" (word not in title or narration)`), video.id);
        script.thumbnailText = thumbText;
      }
      const stillFallback = firstStill(long.files);
      let thumbPath = await makeThumbnail(cfg, script.thumbnailQuery, thumbText, dir, used, stillFallback, videoPath)
        .catch(async (e) => { await incident("thumbnail", e, video.id); return stillFallback; });
      const allCredits = [...long.credits];
      let description = buildDescription(script, script.scenes, timings, video.dossier!, allCredits);

      log(`#${video.id} final check`);
      let review = await finalReview({ dir, script, verification: video.verification!, description, videoPath, shortPath: shortOut?.videoPath, credits: long.credits })
        .catch(async (e) => {
          // 35 minutes of rendering must not be lost because the reviewer was unavailable.
          await incident("final-check.unavailable", e, video.id);
          return unreviewed((e as Error).message.slice(0, 160));
        });

      // Repair rather than discard: a held video is fixed and re-checked before anyone is asked to look at it.
      let repairs = video.repairs ?? 0;
      let rendered = { videoPath, srtPath, timings };
      while (review.decision === "hold" && repairs < MAX_REPAIRS) {
        // A repair round costs roughly 10-15 minutes; never start one we cannot finish.
        if (minutesLeft() < 15) {
          log(`#${video.id} skipping repair — only ${minutesLeft().toFixed(0)} min left in the budget; uploading as is`);
          break;
        }
        repairs++;
        const serious = review.issues.filter((i) => i.severity !== "minor");
        const imageIssues = serious.filter((i) => i.area === "image" || i.area === "thumbnail");
        const scriptIssues = serious.filter((i) => i.area === "script" || i.area === "title");
        log(`#${video.id} repair ${repairs}/${MAX_REPAIRS}: ${imageIssues.length} image, ${scriptIssues.length} script`);

        // 1. swap the images the reviewer rejected (cheap, no re-voicing)
        for (const issue of imageIssues) {
          const idx = script.scenes.findIndex((sc) => sc.id === issue.sceneId);
          if (idx >= 0) {
            const got = await replaceSceneImage(cfg, script.scenes[idx]!, long.files[idx]![0]!, used, video.id, fallbacks).catch(() => null);
            if (got) long.credits[idx] = got;
          }
        }

        // 2. rewrite only what the reviewer objected to, then re-voice just the changed scenes
        let audioChanged = false;
        if (scriptIssues.length) {
          const before = new Map(script.scenes.map((sc) => [sc.id, sc.narration]));
          const repaired = await repairScript({ cfg, playbook, script, dossier: video.dossier!, issues: serious });
          let changed = repaired.scenes.filter((sc) => before.get(sc.id) !== sc.narration);
          if (changed.length > 8 && minutesLeft() < 30) {
            log(`#${video.id} script rewrite touched ${changed.length} scenes but time is short — keeping the original narration`);
            changed = [];
          }
          if (changed.length && changed.length <= repaired.scenes.length) {
            const fresh = await synthesize(cfg, changed, path.join(dir, `audio-r${repairs}`));
            for (const [i, sc] of repaired.scenes.entries()) {
              const f = fresh.find((x) => x.sceneId === sc.id);
              if (f) { audio[i] = f; audioChanged = true; }
              if (before.get(sc.id) !== sc.narration || script.scenes[i]?.imageQuery !== sc.imageQuery) {
                const got = await replaceSceneImage(cfg, sc, long.files[i]![0]!, used, video.id, fallbacks).catch(() => null);
                if (got) long.credits[i] = got;
              }
            }
          }
          script = repaired;
        }

        // 3. re-render, re-thumbnail, re-check
        rendered = await renderVideo({ scenes: script.scenes, images: long.files, audio, dir, seed: video.id + repairs, name: `final-r${repairs}`, captions: captionsFor(script.scenes) });
        const newThumb = await makeThumbnail(cfg, script.thumbnailQuery,
          safeThumbnailText(script.thumbnailText, script.title, script.scenes.map((sc) => sc.narration).join(" ")),
          dir, used, stillFallback, rendered.videoPath).catch(() => thumbPath);
        description = buildDescription(script, script.scenes, rendered.timings, video.dossier!, allCredits);
        review = await finalReview({ dir, script, verification: video.verification!, description, videoPath: rendered.videoPath, shortPath: shortOut?.videoPath, credits: long.credits })
          .catch(async (e) => { await incident("final-check.unavailable", e, video.id); return unreviewed((e as Error).message.slice(0, 160)); });
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

      // FINAL GATE: nothing reaches YouTube unless it is worth uploading. A held video is kept
      // locally, its reasons are recorded for the learning loop, and the day moves on.
      const worthUploading = review.decision !== "hold" || review.overall >= cfg.approval.minScore || cfg.approval.uploadHeldVideos;
      if (!worthUploading) {
        const notes = [
          `**${script.title}** — held at ${review.overall}/10 (bar ${cfg.approval.minScore}).`,
          review.noteForOwner ?? "",
          ...review.issues.map((i) => `- [${i.severity}/${i.area}] ${i.what}${i.fix ? ` → ${i.fix}` : ""}`),
        ].filter(Boolean).join("\n");
        await updateVideo(video.id, { status: "rejected", actual_score: review.overall, review });
        await incident("final-check.not-uploaded", new Error(notes.slice(0, 1500)), video.id);
        await createIssue(`Not uploaded: ${script.title}`.slice(0, 90),
          `${notes}\n\nThe file is in this run's artifacts if you want to watch it. Nothing was uploaded to YouTube.\nThese notes feed the weekly learning cycle.`,
          ["learning"]).catch(() => 0);
        return log(`#${video.id} NOT uploaded (${review.overall}/10 < ${cfg.approval.minScore}). Reasons recorded for the learning loop.`);
      }

      const youtubeId = video.youtube_id ?? await upload(cfg, { videoPath: rendered.videoPath, thumbPath, srtPath: rendered.srtPath, title: script.title, description, tags: script.tags });
      await updateVideo(video.id, { youtube_id: youtubeId });
      video.youtube_id = youtubeId;
      if (shortOut && !video.short_youtube_id) {
        video.short_youtube_id = await upload(cfg, { videoPath: shortOut.videoPath, srtPath: shortOut.srtPath, title: script.short.title, description: buildShortDescription(youtubeId, video.dossier!), tags: script.tags.slice(0, 5) });
        await updateVideo(video.id, { short_youtube_id: video.short_youtube_id });
      }
      await updateVideo(video.id, { status: (stage = "uploaded") });
      log(`#${video.id} uploaded (private): long ${youtubeId}${video.short_youtube_id ? `, short ${video.short_youtube_id}` : ""}`);
    }

    if (stage === "uploaded") await handoff(cfg, video);
  } catch (e) {
    await incident(`produce.${stage}`, e, video.id);
    if (isQuota(e)) {
      // Out of daily model quota: the video keeps its place and its attempts; the next run resumes it.
      log(`#${video.id} paused at "${stage}" — model quota exhausted. The next scheduled run resumes from here.`);
      log(`   Gemini's free daily quota resets at midnight Pacific. To keep going now, add a backup provider (SETUP.md).`);
    } else {
      await q("update videos set attempts = attempts + 1, status = case when attempts + 1 >= $2 then 'failed' else status end where id = $1", [video.id, MAX_ATTEMPTS]);
    }
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
