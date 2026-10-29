/**
 * Clipper M2 — extract.
 *
 * Downloads ONLY the candidate windows via yt-dlp's --download-sections, not the whole source
 * video. For a 170-minute podcast with 4 × 45s picks that's ~3 min of actual video pulled instead
 * of 170 min — ~50× smaller, ~50× faster, and keeps us inside YouTube's rate-limit window on CI.
 *
 * Default is 1080p (bumped from 480p now that we only pull slices). Section downloads produce
 * natively-trimmed mp4s; we re-encode once in the polish step for consistent codec/bitrate.
 *
 * LEGAL: downloads a video the user did not necessarily create. The user has accepted copyright
 * responsibility for this project; the warning is kept in-code so a future reader sees it.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ClipCandidate } from "../yt-clipper.js";
import { ytdlpCommon } from "./ytdlp-args.js";

const exec = promisify(execFile);

export type ExtractedClip = {
  candidate: ClipCandidate;
  rawPath: string;
  durationSec: number;
};

/** Download ONE clip window using yt-dlp --download-sections. The output is already trimmed to the
 *  requested range (keyframe-aligned, with --force-keyframes-at-cuts for frame-accurate boundaries).
 *  Returns the mp4 path. */
/** M14.1 — extra footage downloaded past the LLM-picked end so snap-end has room to extend
 *  into a long-pause end-of-thought. Trial #7b ended at 239.98s on a 240.04s window because
 *  snap could only shrink. With 20s of tail, snap can land on the actual end-of-thought at
 *  e.g. 253s. assemble.ts enforces its own duration ceilings so a 260s "long" clip is still fine. */
const EXTRACT_TAIL_BUFFER_SEC = 20.0;

export async function downloadSection(
  url: string,
  c: ClipCandidate,
  outDir: string,
  maxHeight = 1080,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const name = `clip-${String(c.rank).padStart(2, "0")}_${Math.floor(c.startSec)}-${Math.floor(c.endSec)}`;
  const tmpl = path.join(outDir, `${name}.%(ext)s`);
  // Download with tail buffer; snap decides the final end point.
  const effectiveEnd = c.endSec + EXTRACT_TAIL_BUFFER_SEC;
  const section = `*${c.startSec.toFixed(2)}-${effectiveEnd.toFixed(2)}`;
  await exec("yt-dlp", [
    ...ytdlpCommon(),
    "-f", `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${maxHeight}][ext=mp4]/best[height<=${maxHeight}]`,
    "--merge-output-format", "mp4",
    "--download-sections", section,
    "--force-keyframes-at-cuts",
    "-o", tmpl,
    "--no-warnings", "--no-progress",
    url,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(outDir);
  const mp4 = files.find((f) => f.startsWith(name) && (f.endsWith(".mp4") || f.endsWith(".mkv") || f.endsWith(".webm")));
  if (!mp4) throw new Error(`yt-dlp did not produce a section file for ${name} in ${outDir}`);
  return path.join(outDir, mp4);
}

/** Download every candidate as its own section. One yt-dlp call per candidate so a transient
 *  failure on one doesn't poison the rest. */
export async function extractAll(
  url: string,
  candidates: ClipCandidate[],
  workDir: string,
  maxHeight = 1080,
): Promise<ExtractedClip[]> {
  const clipsDir = path.join(workDir, "clips");
  console.log(`[extract] downloading ${candidates.length} windows at ≤${maxHeight}p → ${clipsDir}`);
  const out: ExtractedClip[] = [];
  for (const c of candidates) {
    try {
      const p = await downloadSection(url, c, clipsDir, maxHeight);
      out.push({ candidate: c, rawPath: p, durationSec: c.endSec - c.startSec });
      console.log(`  ✓ clip ${c.rank} [${Math.floor(c.startSec)}-${Math.floor(c.endSec)}s] → ${path.basename(p)}`);
    } catch (e) {
      console.warn(`  ✗ clip ${c.rank} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (!out.length) throw new Error("extractAll: all candidate downloads failed");
  return out;
}
