/**
 * Clipper M4 — process (Ubuntu). Takes a sections directory from the Mac's fetch job (containing
 * sections.json + the raw mp4s) and runs: snap-to-silence → polish → score → recover → decide →
 * assemble (with attribution overlay). Writes final clips + manifest to `--out`. Records every
 * outcome to data/clipper/outcomes.json for the learning loop.
 *
 * All CPU-heavy work (ffmpeg loudnorm, auto-editor, vertical crop, concat) happens here on free
 * Ubuntu. Mac is done after fetch.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { snapToSilence } from "../src/lib/clipper/snap.js";
import { polish } from "../src/lib/clipper/polish.js";
import { measureAndScore, type ScoreResult } from "../src/lib/clipper/score.js";
import { recover } from "../src/lib/clipper/recover.js";
import { decide } from "../src/lib/clipper/decide.js";
import { makeShort, concatLong, writeManifest } from "../src/lib/clipper/assemble.js";
import { recordProduced, recordRejected } from "../src/lib/clipper/outcomes.js";
import { upsert } from "../src/lib/clipper/state.js";
import { checkCropSafety } from "../src/lib/clipper/crop-safety.js";
import { qcCheck } from "../src/lib/clipper/qc.js";
import { transcribeToSRT, speechDensity } from "../src/lib/clipper/captions.js";
import { scorePreShip, SHIP_SCORE_FLOOR } from "../src/lib/clipper/pre-ship-scorer.js";
import { uploadClip } from "../src/lib/clipper/upload.js";
import { recordPublished } from "../src/lib/clipper/outcomes.js";
import type { ClipCandidate } from "../src/lib/yt-clipper.js";

type SectionsFile = {
  url: string;
  meta: { id: string; title: string; uploader: string; durationSec: number };
  picks: ClipCandidate[];
  sections: Array<{ rank: number; path: string }>;
  /** M5: format hint from retention-planner — "shorts" or "long". When present the decider respects
   *  it rather than running the sum-based auto rule. */
  format?: "shorts" | "long";
  source?: "retention" | "llm-fallback";
  curveSignals?: string[];
  /** M8.4: source provenance (yt-dlp -J snapshot at fetch time, honest about rights). */
  provenance?: Record<string, unknown>;
};

function parseArgs(argv: string[]): { sections: string; out: string; format: "auto"|"shorts"|"long" } {
  let sections = "work/clipper/sections", out = "work/clipper/final", format: "auto"|"shorts"|"long" = "auto";
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--sections" && a[i + 1]) sections = a[++i]!;
    else if (a[i] === "--out" && a[i + 1]) out = a[++i]!;
    else if (a[i] === "--format" && a[i + 1]) format = a[++i]! as "auto"|"shorts"|"long";
  }
  return { sections, out, format };
}

async function main() {
  const { sections: sectionsDir, out, format } = parseArgs(process.argv);
  const sf = JSON.parse(await readFile(path.join(sectionsDir, "sections.json"), "utf8")) as SectionsFile;
  await mkdir(out, { recursive: true });
  console.log(`[clip:process] ${sf.sections.length} sections, format=${format}`);

  // snap → polish → score, per section.
  const polishedDir = path.join(out, "polished");
  const snappedDir = path.join(out, "snapped");
  await mkdir(polishedDir, { recursive: true });
  await mkdir(snappedDir, { recursive: true });
  const scoredByPick: Array<{ pick: ClipCandidate; score: ScoreResult }> = [];

  const MIN_SPEECH_DENSITY = 0.4;             // M11.2 — ≥40% of clip must be speech
  for (const s of sf.sections) {
    const rawPath = path.join(sectionsDir, s.path);
    const pick = sf.picks.find((p) => p.rank === s.rank);
    if (!pick) { console.warn(`  no pick for rank ${s.rank}, skipping`); continue; }
    console.log(`  rank ${s.rank}: transcribe-raw → snap → polish → score`);
    // M8.5: transcribe RAW section first with tiny model so snap-to-silence can prefer silences
    // that fall at sentence endings. Non-fatal if whisper unavailable; snap falls back to pure
    // silence detection.
    const rawSrt = await transcribeToSRT(rawPath, "tiny");
    // M11.2 — speech-density gate. If the clip has <40% speech coverage, a cold viewer walks
    // in on gameplay / music / ambient footage with no narration. Reject before wasting polish
    // and encode time. Only skippable if whisper didn't run (no SRT) — then we accept the clip
    // because we can't honestly judge.
    if (rawSrt) {
      const clipDur = pick.endSec - pick.startSec;
      const density = await speechDensity(rawSrt, clipDur);
      if (density < MIN_SPEECH_DENSITY) {
        console.warn(`    [speech-density] ${(density * 100).toFixed(0)}% < ${MIN_SPEECH_DENSITY * 100}% — rejecting as non-narrated`);
        await recordRejected(sf.meta.id, {
          sourceTitle: sf.meta.title, sourceChannel: sf.meta.uploader,
          clipScore: 0, rejectReason: `non-narrated (speech density ${(density * 100).toFixed(0)}%)`,
          rejectDetails: { speechDensity: density, clipDurationSec: clipDur },
        });
        continue;
      }
      console.log(`    [speech-density] ${(density * 100).toFixed(0)}% ✓`);
    }
    const snapped = await snapToSilence(rawPath, snappedDir, rawSrt ?? undefined);
    const polished = await polish(snapped, polishedDir);
    const probeBand = format === "long" ? "long" : "shorts";
    let scored = await measureAndScore(polished.outputPath, probeBand);
    console.log(`    initial score=${scored.score} ${scored.passed ? "PASS" : "FAIL"}${scored.criticalFails.length ? " [critical: " + scored.criticalFails.join(",") + "]" : ""}`);
    if (!scored.passed) {
      try {
        const r = await recover(polished.outputPath, polishedDir);
        const re = await measureAndScore(r.outputPath, probeBand);
        console.log(`    recovered score=${re.score} ${re.passed ? "PASS" : "FAIL"}`);
        if (re.passed) scored = re;
      } catch (e) { console.warn(`    recover failed: ${(e as Error).message}`); }
    }
    scoredByPick.push({ pick, score: scored });
  }

  const scored = scoredByPick.map((s) => s.score);
  // M5: plan.format from retention-planner wins over "auto". Only --format=shorts/long overrides it.
  const effectiveFormat = format !== "auto" ? format : (sf.format ?? "auto");
  const decision = effectiveFormat === "auto" ? decide(scored) : (() => {
    const d = decide(scored); d.format = effectiveFormat; return d;
  })();
  console.log(`[clip:process] decision: ${decision.format} — ${decision.rationale} (hint from plan: ${sf.format ?? "none"})`);

  // Record every scored clip's outcome — passed or rejected — so the learning loop has data.
  for (const { pick: _pick, score: s } of scoredByPick) {
    if (s.passed && decision.chosen.includes(s)) {
      await recordProduced(sf.meta.id, s.path, {
        sourceTitle: sf.meta.title,
        sourceChannel: sf.meta.uploader,
        clipScore: s.score,
        gatesPassed: Object.entries(s.gateBreakdown).filter(([, v]) => v > 0).map(([k]) => k),
        gatesFailed: Object.entries(s.gateBreakdown).filter(([, v]) => v === 0).map(([k]) => k),
        decisionFormat: decision.format === "none" ? undefined : decision.format,
        decisionRationale: decision.rationale,
      });
    } else {
      await recordRejected(sf.meta.id, {
        sourceTitle: sf.meta.title,
        sourceChannel: sf.meta.uploader,
        clipScore: s.score,
        gatesFailed: Object.entries(s.gateBreakdown).filter(([, v]) => v === 0).map(([k]) => k),
        criticalFails: s.criticalFails,
        rejectReason: s.criticalFails.length ? `critical: ${s.criticalFails.join(",")}` : `score ${s.score}<80`,
      });
    }
  }

  if (decision.format === "none") {
    console.error("\n✗ nothing shipped — all candidates dropped by gates.");
    await writeManifest(out, { source: { url: sf.url, title: sf.meta.title, uploader: sf.meta.uploader, durationSec: sf.meta.durationSec }, decision, scoredAll: scored, outputs: [] });
    await upsert(sf.meta.id, { title: sf.meta.title, channelTitle: sf.meta.uploader, status: "dropped", notes: decision.rationale });
    process.exit(0);
  }

  // M6 — crop-safety: shorts only. Four outcomes (M9.1 adds shifted-crop):
  //   • center-crop:  faces centered in the 9:16 stripe → classic destructive crop
  //   • shifted-crop: faces STABLE but off-center → shift the stripe to match (M9.1)
  //   • blurred-bg:   faces off-center & moving, or multi-subject → letterbox on blur
  //   • unsafe:       no face signal AND no center-weighted content → reject
  const layoutByPath = new Map<string, "center-crop" | "shifted-crop" | "blurred-bg">();
  const cropCenterByPath = new Map<string, number>();   // M9.1 — carries normalized x for shifted-crop
  if (decision.format === "shorts") {
    const kept: typeof decision.chosen = [];
    for (const s of decision.chosen) {
      const cs = await checkCropSafety(s.path);
      console.log(`  crop-safety ${path.basename(s.path)}: ${cs.layout.toUpperCase()} — ${cs.reason}` +
        ` (faces=${cs.framesWithFace}/${cs.samples}, centered=${(cs.centeredRatio * 100).toFixed(0)}%, cuts=${cs.sceneCuts}, cropX=${(cs.cropCenterXNorm * 100).toFixed(0)}%)`);
      if (cs.layout === "unsafe") {
        await recordRejected(sf.meta.id, {
          sourceTitle: sf.meta.title, sourceChannel: sf.meta.uploader,
          clipScore: s.score, rejectReason: `crop-unsafe: ${cs.reason}`,
          rejectDetails: {
            centeredRatio: cs.centeredRatio, sceneCuts: cs.sceneCuts,
            framesWithFace: cs.framesWithFace, facesTotal: cs.facesTotal,
            facePresenceRatio: cs.facePresenceRatio,
          },
        });
        continue;
      }
      layoutByPath.set(s.path, cs.layout);
      cropCenterByPath.set(s.path, cs.cropCenterXNorm);
      kept.push(s);
    }
    if (!kept.length) {
      console.error("\n✗ all passing clips failed crop-safety. Dropping source.");
      await writeManifest(out, { source: { url: sf.url, title: sf.meta.title, uploader: sf.meta.uploader, durationSec: sf.meta.durationSec }, decision: { ...decision, format: "none", chosen: [], rationale: decision.rationale + " [all failed crop-safety]" }, scoredAll: scored, outputs: [] });
      await upsert(sf.meta.id, { title: sf.meta.title, channelTitle: sf.meta.uploader, status: "dropped", notes: "all passing clips failed crop-safety" });
      process.exit(0);
    }
    decision.chosen = kept;
  }

  // Assemble with attribution overlay, then run post-render QC (M6.5) on every output and
  // drop any that fail (title-card, sliced face, bad dims). Track which clips had faces in the
  // source so QC knows whether to expect them in the output.
  const finalDir = path.join(out, "final");
  await mkdir(finalDir, { recursive: true });
  const outputs: string[] = [];
  const attr = { channel: sf.meta.uploader, title: sf.meta.title };
  // Rebuild expectFaces lookup from the earlier crop-safety pass: if the source clip had faces
  // in ≥30% of samples, the final output should too.
  // (This map was built implicitly earlier; the processor already called checkCropSafety per
  // clip. We re-call cheaply only for the clips that end up in `decision.chosen`.)
  const expectFacesByPath = new Map<string, boolean>();
  if (decision.format === "shorts") {
    for (const s of decision.chosen) {
      // M9.1: blurred-bg AND shifted-crop both prove faces were detected (they only exist as
      // decisions when face_scan returned face data). center-crop may or may not have had
      // faces — treat as expectFaces=false to stay conservative.
      const l = layoutByPath.get(s.path);
      expectFacesByPath.set(s.path, l === "blurred-bg" || l === "shifted-crop");
    }
  }
  if (decision.format === "shorts") {
    const kept: Array<{ src: ReturnType<typeof scored.at>; o: string; layout: "center-crop" | "blurred-bg" }> = [] as never;
    for (let i = 0; i < decision.chosen.length; i++) {
      const s = decision.chosen[i]!;
      const layout = layoutByPath.get(s.path) ?? "center-crop";
      // M7.4: whisper transcribe this clip's polished audio → SRT. If it fails, we still ship
      // the clip without captions rather than block the render.
      const srtPath = await transcribeToSRT(s.path);
      if (srtPath) console.log(`  short ${i + 1}: captions → ${path.basename(srtPath)}`);
      else console.log(`  short ${i + 1}: captions skipped (whisper unavailable or failed)`);
      const cropCenter = cropCenterByPath.get(s.path) ?? 0.5;
      const o = await makeShort(s.path, finalDir, String(i + 1).padStart(2, "0"), attr, layout, srtPath ? { srtPath } : undefined, cropCenter);
      const q = await qcCheck(o, { expectFaces: expectFacesByPath.get(s.path) ?? false });
      if (q.passed) {
        outputs.push(o);
        console.log(`  short ${i + 1} (${layout}) → ${path.basename(o)} [QC OK ${q.dimensions.width}x${q.dimensions.height}, ${q.durationSec.toFixed(1)}s, faces ${q.framesWithFace}/${q.totalFrames}]`);
      } else {
        console.warn(`  short ${i + 1} (${layout}) → ${path.basename(o)} [QC FAIL: ${q.reasons.join("; ")}] — dropping`);
        await recordRejected(sf.meta.id, {
          sourceTitle: sf.meta.title, sourceChannel: sf.meta.uploader,
          clipScore: s.score, rejectReason: `qc-fail: ${q.reasons[0] ?? "unknown"}`,
          rejectDetails: {
            qcReasons: q.reasons, dims: q.dimensions, duration: q.durationSec,
            blackRatio: q.blackFrameRatio, facesIn: q.framesWithFace, slicedSamples: q.slicedFaceSamples,
          },
        });
        try { await (await import("node:fs/promises")).unlink(o); } catch { /* best-effort */ }
      }
    }
    if (!outputs.length) {
      console.error("\n✗ all rendered shorts failed QC. Dropping source.");
      await writeManifest(out, { source: { url: sf.url, title: sf.meta.title, uploader: sf.meta.uploader, durationSec: sf.meta.durationSec }, decision: { ...decision, format: "none", chosen: [], rationale: decision.rationale + " [all failed QC]" }, scoredAll: scored, outputs: [] });
      await upsert(sf.meta.id, { title: sf.meta.title, channelTitle: sf.meta.uploader, status: "dropped", notes: "all rendered shorts failed post-render QC" });
      process.exit(0);
    }
  } else {
    // M11.4 — handle empty-chosen on the long path cleanly. Trial #4 crashed here with
    // "concatLong: no clips" after the decider correctly said "drop this source — do not ship
    // bad work." The shorts path exits cleanly in this case; long needs the same treatment.
    if (!decision.chosen.length) {
      console.error("\n✗ no clips passed scoring/recovery for long format. Dropping source.");
      await writeManifest(out, {
        source: { url: sf.url, title: sf.meta.title, uploader: sf.meta.uploader, durationSec: sf.meta.durationSec },
        provenance: sf.provenance ?? null,
        decision: { ...decision, format: "none", chosen: [], rationale: decision.rationale + " [all failed scoring]" },
        scoredAll: scored, outputs: [],
      });
      await upsert(sf.meta.id, { title: sf.meta.title, channelTitle: sf.meta.uploader, status: "dropped", notes: "all clips failed scoring" });
      process.exit(0);
    }
    // M12.1 — long path now gets attribution + whisper captions, matching shorts behavior.
    // We transcribe the FIRST chosen clip's polished audio with the base model (same quality as
    // shorts captions). On a multi-clip concat the SRT only aligns with the first segment's audio
    // so captions beyond that drift — in practice our long picks are a single 4-15min retention
    // window, so this is a non-issue today. Document for the future.
    const firstLongPath = decision.chosen[0]!.path;
    const longSrt = await transcribeToSRT(firstLongPath, "base");
    if (longSrt) console.log(`  long: captions → ${path.basename(longSrt)}`);
    else console.log(`  long: captions skipped (whisper unavailable or failed)`);
    const o = await concatLong(
      decision.chosen.map((c) => c.path), finalDir, "long",
      attr, longSrt ? { srtPath: longSrt } : undefined,
    );
    outputs.push(o);
    console.log(`  long → ${path.basename(o)} (with attribution + captions)`);
  }

  // M8.4: emit full provenance in the manifest so human review (and the upload step) can see
  // license, review flags, and attribution requirements per spec section 9.
  // M12.3 — HARSH pre-ship viral scorer. Runs on every produced output. Score ≥ 8/10 →
  // auto-upload to YouTube Studio (unlisted) + record published outcome. Score < 8 → record
  // "pre-ship-rejected" outcome so the learning loop knows what the ranker over-promised.
  // If YT_CLIENT_* creds aren't in env (local run), upload is skipped but verdict still recorded.
  const preShipVerdicts: Array<{ output: string; verdict: unknown; shipped: boolean; studioUrl?: string }> = [];
  const hasYtCreds = !!(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET && process.env.YT_REFRESH_TOKEN);
  for (let i = 0; i < outputs.length; i++) {
    const outPath = outputs[i]!;
    // Transcribe final for scorer (reuse the whisper SRT written during assembly where possible —
    // but it's keyed by polished-source path, not final-output path; cheapest: re-transcribe the
    // final, same base model, ~30s).
    const finalSrt = await transcribeToSRT(outPath, "base");
    const chosenScored = decision.chosen[i];
    const narrativeViral = (sf.meta as unknown as { signals?: Record<string, number> }).signals?.narrative_viral;
    const narrativeTypeIdx = (sf.meta as unknown as { signals?: Record<string, number> }).signals?.narrative_type_idx;
    const typeNames = ["filler","challenge","experiment","competition","reaction","skill-demo","storytelling","reveal","comedy","stunt"];
    const narrativeType = typeof narrativeTypeIdx === "number" && narrativeTypeIdx >= 0 ? typeNames[narrativeTypeIdx] : undefined;
    const verdict = await scorePreShip({
      clipTitle: sf.meta.title,
      sourceChannel: sf.meta.uploader,
      format: decision.format,
      durationSec: chosenScored?.durationSec ?? 60,
      srtPath: finalSrt ?? undefined,
      narrativeViral,
      narrativeType,
    });
    if (!verdict) {
      console.warn(`  [pre-ship] ${path.basename(outPath)}: scorer unavailable — holding for human review (no auto-ship)`);
      preShipVerdicts.push({ output: outPath, verdict: null, shipped: false });
      continue;
    }
    console.log(`  [pre-ship] ${path.basename(outPath)}: score=${verdict.score}/10 verdict=${verdict.verdict} (${verdict.rationale.slice(0, 120)})`);
    if (verdict.verdict === "ship" && verdict.score >= SHIP_SCORE_FLOOR && hasYtCreds) {
      try {
        const title = (sf.meta.title.length > 95 ? sf.meta.title.slice(0, 92) + "…" : sf.meta.title) + (decision.format === "shorts" ? " #Shorts" : "");
        const desc = `Clip from "${sf.meta.title}" by ${sf.meta.uploader} — ${sf.url}\n\nOriginal rights with the creator; used for commentary / discovery.`;
        const up = await uploadClip({
          filePath: outPath, title, description: desc,
          privacyStatus: "unlisted", categoryId: "24",
        });
        console.log(`    ✓ auto-shipped to Studio: ${up.studioUrl}`);
        await recordPublished(sf.meta.id, up.videoId, { sourceTitle: sf.meta.title });
        preShipVerdicts.push({ output: outPath, verdict, shipped: true, studioUrl: up.studioUrl });
      } catch (e) {
        console.warn(`    ✗ auto-ship failed: ${(e as Error).message.split("\n")[0]} — holding for human review`);
        preShipVerdicts.push({ output: outPath, verdict, shipped: false });
      }
    } else {
      // Below the floor OR no YT creds → feed to learning loop. Clip stays in the artifact for
      // the human to inspect from the review issue if they want.
      await recordRejected(sf.meta.id, {
        sourceTitle: sf.meta.title, sourceChannel: sf.meta.uploader,
        clipScore: verdict.score * 10,  // normalize to 0-100 for the outcomes schema
        rejectReason: verdict.verdict === "ship" ? "ship-approved-but-no-yt-creds" : `pre-ship score ${verdict.score}/10 < ${SHIP_SCORE_FLOOR}`,
        rejectDetails: {
          preShipScore: verdict.score,
          preShipDimensions: verdict.dimensions,
          preShipLearnReasons: verdict.learnReasons,
        },
      });
      preShipVerdicts.push({ output: outPath, verdict, shipped: false });
    }
  }

  await writeManifest(out, {
    source: { url: sf.url, title: sf.meta.title, uploader: sf.meta.uploader, durationSec: sf.meta.durationSec },
    provenance: sf.provenance ?? null,
    picks: sf.picks, scoredAll: scored, decision, outputs,
    preShip: preShipVerdicts,       // M12.3 — per-output ship/learn verdicts + shipped Studio URLs
  });
  await upsert(sf.meta.id, { title: sf.meta.title, channelTitle: sf.meta.uploader, status: "pending", clipPaths: outputs });
  console.log(`\n✓ clip:process done — ${outputs.length} ${decision.format}`);
}

main().catch((e) => { console.error(`\n✗ clip:process failed: ${(e as Error).stack ?? e}`); process.exit(1); });
