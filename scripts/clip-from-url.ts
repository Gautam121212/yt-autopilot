/**
 * Clipper M1: find viral clips inside a long YouTube video.
 *
 * Usage:
 *   npm run clip -- https://www.youtube.com/watch?v=XXXXXXXXXXX
 *   npm run clip -- --url https://youtu.be/XXXXXXXXXXX --json out/candidates.json
 *   npm run clip -- --url ... --lang en
 *
 * Pipeline (M1 only):
 *   1. yt-dlp fetches video metadata (title, duration, chapters, view count).
 *   2. yt-dlp fetches auto-captions as a .vtt file.
 *   3. parseVtt() + transcriptForLlm() build a timestamped transcript.
 *   4. pickCandidates() asks the project LLM to apply the yt-shorts gates and return top-5.
 *   5. formatCandidates() prints a terminal report; --json also writes the raw object.
 *
 * No video stream is downloaded here. Clip extraction (ffmpeg cut, vertical crop, polish via
 * OpenMontage) comes in M2. Upload comes in M3. See README section "YT Clipper" after M3 lands.
 *
 * LEGAL: this downloads captions from videos you don't own. The user has accepted responsibility.
 */
import { writeFile } from "node:fs/promises";
import { fetchMeta, fetchCaptions, pickCandidates, formatCandidates } from "../src/lib/yt-clipper.js";

function parseArgs(argv: string[]): { url: string; lang: string; jsonOut?: string } {
  let url = "";
  let lang = "en";
  let jsonOut: string | undefined;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--url" && args[i + 1]) { url = args[++i]!; }
    else if (a === "--lang" && args[i + 1]) { lang = args[++i]!; }
    else if (a === "--json" && args[i + 1]) { jsonOut = args[++i]!; }
    else if (!a.startsWith("--") && !url) { url = a; }
  }
  if (!url) {
    console.error("usage: npm run clip -- <youtube-url> [--lang en] [--json out.json]");
    process.exit(2);
  }
  return { url, lang, jsonOut };
}

async function main() {
  const { url, lang, jsonOut } = parseArgs(process.argv);
  console.log(`[clip] fetching metadata for ${url}`);
  const meta = await fetchMeta(url);
  console.log(`[clip] ${meta.title} by ${meta.uploader} — ${Math.floor(meta.durationSec / 60)}m${meta.durationSec % 60}s`);
  if (meta.chapters?.length) console.log(`[clip] ${meta.chapters.length} chapters found`);

  console.log(`[clip] fetching ${lang} auto-captions`);
  const cues = await fetchCaptions(url, lang);
  console.log(`[clip] ${cues.length} caption cues parsed`);
  if (!cues.length) { console.error("[clip] no cues parsed — the .vtt may be in a format we don't yet handle"); process.exit(1); }

  console.log(`[clip] asking the LLM to pick candidates (this takes 30-90s on heavy tier)…`);
  const list = await pickCandidates(meta, cues);

  const report = formatCandidates(meta, list);
  console.log(report);

  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify({ meta, candidates: list.candidates }, null, 2));
    console.log(`\n[clip] wrote ${jsonOut}`);
  }
  console.log(`\nShip one, or change one?`);
}

main().catch((e) => { console.error(`\n✗ clip failed: ${(e as Error).message}`); process.exit(1); });
