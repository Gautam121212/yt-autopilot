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

  for (const s of sf.sections) {
    const rawPath = path.join(sectionsDir, s.path);
    const pick = sf.picks.find((p) => p.rank === s.rank);
    if (!pick) { console.warn(`  no pick for rank ${s.rank}, skipping`); continue; }
    console.log(`  rank ${s.rank}: snap → polish → score`);
    const snapped = await snapToSilence(rawPath, snappedDir);
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

  // M5 — crop-safety: shorts only. Reject any clip whose active content drifts outside the 9:16
  // center stripe, so faces/subjects don't get sliced off when vertical-cropped.
  if (decision.format === "shorts") {
    const safe: typeof decision.chosen = [];
    for (const s of decision.chosen) {
      const cs = await checkCropSafety(s.path);
      console.log(`  crop-safety ${path.basename(s.path)}: ${cs.safeForCrop ? "SAFE" : "UNSAFE"} — ${cs.reason}`);
      if (cs.safeForCrop) safe.push(s);
      else {
        await recordRejected(sf.meta.id, {
          sourceTitle: sf.meta.title, sourceChannel: sf.meta.uploader,
          clipScore: s.score, rejectReason: `crop-unsafe: ${cs.reason}`,
          rejectDetails: { centeredRatio: cs.centeredRatio, sceneCuts: cs.sceneCuts },
        });
      }
    }
    if (!safe.length) {
      console.error("\n✗ all passing clips failed crop-safety. Dropping source.");
      await writeManifest(out, { source: { url: sf.url, title: sf.meta.title, uploader: sf.meta.uploader, durationSec: sf.meta.durationSec }, decision: { ...decision, format: "none", chosen: [], rationale: decision.rationale + " [all failed crop-safety]" }, scoredAll: scored, outputs: [] });
      await upsert(sf.meta.id, { title: sf.meta.title, channelTitle: sf.meta.uploader, status: "dropped", notes: "all passing clips failed crop-safety" });
      process.exit(0);
    }
    decision.chosen = safe;
  }

  // Assemble with attribution overlay.
  const finalDir = path.join(out, "final");
  await mkdir(finalDir, { recursive: true });
  const outputs: string[] = [];
  const attr = { channel: sf.meta.uploader, title: sf.meta.title };
  if (decision.format === "shorts") {
    for (let i = 0; i < decision.chosen.length; i++) {
      const s = decision.chosen[i]!;
      const o = await makeShort(s.path, finalDir, String(i + 1).padStart(2, "0"), attr);
      outputs.push(o);
      console.log(`  short ${i + 1} → ${path.basename(o)}`);
    }
  } else {
    const o = await concatLong(decision.chosen.map((c) => c.path), finalDir);
    outputs.push(o);
    console.log(`  long → ${path.basename(o)}`);
  }

  await writeManifest(out, { source: { url: sf.url, title: sf.meta.title, uploader: sf.meta.uploader, durationSec: sf.meta.durationSec }, picks: sf.picks, scoredAll: scored, decision, outputs });
  await upsert(sf.meta.id, { title: sf.meta.title, channelTitle: sf.meta.uploader, status: "pending", clipPaths: outputs });
  console.log(`\n✓ clip:process done — ${outputs.length} ${decision.format}`);
}

main().catch((e) => { console.error(`\n✗ clip:process failed: ${(e as Error).stack ?? e}`); process.exit(1); });
