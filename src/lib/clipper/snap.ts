/**
 * Clipper M4 — snap. Takes an LLM-picked (start,end) window and nudges each boundary to the
 * nearest silence inside ±2s. Prevents clips from starting mid-word or ending on a trailing
 * breath, which was the top complaint on the first real pipeline output.
 *
 * Runs AFTER extract — operates on the already-trimmed clip mp4. Uses ffmpeg silencedetect to
 * find silence gaps, then ffmpeg -ss/-to to re-trim. If no silence boundary exists within ±2s
 * (dense speech, no pauses), returns the original clip untouched.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SEARCH_WINDOW_SEC = 2.0;      // ± how far from the picked boundary we'll look
const SILENCE_NOISE_DB = -30;       // what we count as "silence"
const SILENCE_MIN_SEC = 0.25;       // ignore clicks; need at least 250ms of continuous silence

type SilenceRange = { start: number; end: number };

async function detectSilences(inputPath: string): Promise<SilenceRange[]> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-nostats", "-i", inputPath, "-af", `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SEC}`, "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", () => {
      const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
      const ends = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:/g)].map((m) => Number(m[1]));
      const ranges: SilenceRange[] = [];
      for (let i = 0; i < Math.min(starts.length, ends.length); i++) ranges.push({ start: starts[i]!, end: ends[i]! });
      resolve(ranges);
    });
  });
}

/** Snap the clip's boundaries to the nearest silence within ±2s. Writes the snapped version to
 *  `${base}.snapped.mp4` and returns its path. On no silence found, returns inputPath unchanged. */
export async function snapToSilence(inputPath: string, outDir: string): Promise<string> {
  const silences = await detectSilences(inputPath);
  // Current clip's real duration (from ffprobe — don't trust fine math).
  const probe = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath]);
  const dur = parseFloat(probe.stdout.trim());
  if (!dur || silences.length === 0) return inputPath;

  // Start-snap: the END of a silence range that's within [0, SEARCH_WINDOW_SEC].
  // That silence ended → speech began → good start point.
  const startCandidates = silences.filter((s) => s.end <= SEARCH_WINDOW_SEC).map((s) => s.end);
  const startSec = startCandidates.length ? Math.max(...startCandidates) : 0;

  // End-snap: the START of a silence range that's within [dur - SEARCH_WINDOW_SEC, dur].
  // That silence started → speech ended → good end point.
  const endCandidates = silences.filter((s) => s.start >= dur - SEARCH_WINDOW_SEC).map((s) => s.start);
  const endSec = endCandidates.length ? Math.min(...endCandidates) : dur;

  // If snapped window is too tiny (e.g. silence consumed most of the clip), bail.
  const snappedDur = endSec - startSec;
  if (snappedDur < 10) return inputPath;

  // If snap barely changed anything (<0.1s each side), skip the re-encode.
  if (startSec < 0.1 && (dur - endSec) < 0.1) return inputPath;

  const base = path.basename(inputPath, path.extname(inputPath));
  const output = path.join(outDir, `${base}.snapped.mp4`);
  await exec("ffmpeg", [
    "-y", "-v", "error",
    "-ss", startSec.toFixed(3), "-i", inputPath, "-t", snappedDur.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return output;
}
