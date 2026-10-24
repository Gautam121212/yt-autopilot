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
import { fetchMeta, fetchCaptions, pickCandidates } from "../src/lib/yt-clipper.js";

function parseArgs(argv: string[]): { url: string; out: string; lang: string } {
  let url = "", lang = "en", out = "work/clipper/plan.json";
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--url" && a[i + 1]) url = a[++i]!;
    else if (a[i] === "--lang" && a[i + 1]) lang = a[++i]!;
    else if (a[i] === "--out" && a[i + 1]) out = a[++i]!;
    else if (!a[i]!.startsWith("--") && !url) url = a[i]!;
  }
  if (!url) { console.error("usage: clip-plan <url> [--lang en] [--out plan.json]"); process.exit(2); }
  return { url, out, lang };
}

async function main() {
  const { url, out, lang } = parseArgs(process.argv);
  console.log(`[clip:plan] ${url}`);
  const meta = await fetchMeta(url);
  console.log(`  meta: ${meta.title} by ${meta.uploader} — ${Math.floor(meta.durationSec / 60)}m`);
  const cues = await fetchCaptions(url, lang);
  console.log(`  captions: ${cues.length} cues`);
  const list = await pickCandidates(meta, cues);
  console.log(`  LLM picked: ${list.candidates.length} candidates`);

  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, JSON.stringify({ url, meta, picks: list.candidates }, null, 2));
  console.log(`✓ wrote ${out}`);
}

main().catch((e) => { console.error(`\n✗ clip:plan failed: ${(e as Error).stack ?? e}`); process.exit(1); });
