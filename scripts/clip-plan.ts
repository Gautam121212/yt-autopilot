/**
 * Clipper M4 — plan (Ubuntu). Takes a YouTube URL, pulls metadata + captions via YouTube API +
 * yt-dlp subs-only, runs the LLM pick, and writes a `plan.json` with:
 *    - meta  (title, uploader, duration, chapters)
 *    - picks (candidate windows: {rank, startSec, endSec, hooks...})
 *
 * This runs on Ubuntu (free CI). The Mac never sees this step — no video stream is fetched, only
 * caption text and metadata, which don't trip bot-check as hard. The next job (clip-fetch) runs
 * on the Mac and downloads only the chosen windows.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { plan as retentionPlan } from "../src/lib/clipper/retention-planner.js";

function parseArgs(argv: string[]): { url: string; out: string } {
  let url = "", out = "work/clipper/plan.json";
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--url" && a[i + 1]) url = a[++i]!;
    else if (a[i] === "--out" && a[i + 1]) out = a[++i]!;
    else if (!a[i]!.startsWith("--") && !url) url = a[i]!;
  }
  if (!url) { console.error("usage: clip-plan <url> [--out plan.json]"); process.exit(2); }
  return { url, out };
}

async function main() {
  const { url, out } = parseArgs(process.argv);
  console.log(`[clip:plan] ${url}`);
  const p = await retentionPlan(url);
  console.log(`[clip:plan] source=${p.source} format=${p.format} picks=${p.picks.length} signals=${p.curveSignals.join("+") || "(none)"}`);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, JSON.stringify(p, null, 2));
  console.log(`✓ wrote ${out}`);
}

main().catch((e) => { console.error(`\n✗ clip:plan failed: ${(e as Error).stack ?? e}`); process.exit(1); });
