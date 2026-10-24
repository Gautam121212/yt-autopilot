/**
 * Clipper M2 — extract.
 *
 * Downloads the source video via yt-dlp (480p by default — plenty for clipping, keeps bandwidth low)
 * and cuts each candidate window into its own mp4 using ffmpeg. We re-encode here (not stream-copy)
 * because stream-copy can't honor arbitrary start times accurately and would also skip the keyframe
 * boundary alignment that silence detection relies on.
 *
 * LEGAL: downloads a video the user did not necessarily create. The user has accepted copyright
 * responsibility for this project; the warning is kept in-code so a future reader sees it.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ClipCandidate } from "../yt-clipper.js";

const exec = promisify(execFile);

export type ExtractedClip = {
  candidate: ClipCandidate;
  rawPath: string;
  durationSec: number;
};

/** Download the source video to the given directory at a reasonable quality. Returns the file path. */
export async function downloadSource(url: string, outDir: string, maxHeight = 480): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const tmpl = path.join(outDir, "source.%(ext)s");
  await exec("yt-dlp", [
    "-f", `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${maxHeight}][ext=mp4]/best[height<=${maxHeight}]`,
    "--merge-output-format", "mp4",
    "-o", tmpl,
    "--no-warnings", "--no-progress",
    url,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(outDir);
  const mp4 = files.find((f) => f.startsWith("source.") && (f.endsWith(".mp4") || f.endsWith(".mkv") || f.endsWith(".webm")));
  if (!mp4) throw new Error(`yt-dlp did not produce a source file in ${outDir}`);
  return path.join(outDir, mp4);
}

/** Cut one candidate window out of the source. Re-encodes (keyframe-accurate), scales nothing (we
 *  do format work later). Suffixes with the rank + timecodes so the filename is readable. */
export async function cutWindow(sourcePath: string, c: ClipCandidate, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const name = `clip-${String(c.rank).padStart(2, "0")}_${Math.floor(c.startSec)}-${Math.floor(c.endSec)}.mp4`;
  const out = path.join(outDir, name);
  const duration = (c.endSec - c.startSec).toFixed(3);
  // Input seek (-ss BEFORE -i) is fast but not frame-accurate; combined with -t and re-encode we
  // get fast seek + accurate cut. Keep audio stereo 48kHz for consistency with the project standard.
  await exec("ffmpeg", [
    "-y", "-v", "error",
    "-ss", c.startSec.toFixed(3), "-i", sourcePath, "-t", duration,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    out,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return out;
}

/** Convenience: download + cut all candidates in one call. */
export async function extractAll(url: string, candidates: ClipCandidate[], workDir: string): Promise<ExtractedClip[]> {
  const sourceDir = path.join(workDir, "source");
  const clipsDir = path.join(workDir, "clips");
  console.log(`[extract] downloading source → ${sourceDir}`);
  const src = await downloadSource(url, sourceDir);
  console.log(`[extract] cutting ${candidates.length} windows → ${clipsDir}`);
  const out: ExtractedClip[] = [];
  for (const c of candidates) {
    const p = await cutWindow(src, c, clipsDir);
    out.push({ candidate: c, rawPath: p, durationSec: c.endSec - c.startSec });
  }
  return out;
}
