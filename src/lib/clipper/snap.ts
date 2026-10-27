/**
 * Clipper M4 — snap. Takes an LLM-picked (start,end) window and nudges each boundary to the
 * nearest silence inside ±2s. Prevents clips from starting mid-word or ending on a trailing
 * breath, which was the top complaint on the first real pipeline output.
 *
 * M8.5 — now ALSO respects sentence boundaries from the whisper SRT when available. Picking the
 * silence that falls at a sentence end (word ends in . ! ?) beats picking any silence, because
 * the latter can split a conjunction ("and ..." / "but ..."). Falls back to pure silence-based
 * when no SRT is around (e.g. non-speech clip, music).
 *
 * Runs AFTER extract — operates on the already-trimmed clip mp4. Uses ffmpeg silencedetect to
 * find silence gaps, then ffmpeg -ss/-to to re-trim. If no silence boundary exists within ±2s
 * (dense speech, no pauses), returns the original clip untouched.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SEARCH_WINDOW_SEC = 2.0;      // ± how far from the picked boundary we'll look
const SILENCE_NOISE_DB = -30;       // what we count as "silence"
const SILENCE_MIN_SEC = 0.25;       // ignore clicks; need at least 250ms of continuous silence
const SENTENCE_END_RE = /[.!?](["')\]]*)\s*$/;

type SilenceRange = { start: number; end: number };
type Cue = { startSec: number; endSec: number; endsAtSentence: boolean };

/** M8.5 — parse a whisper SRT file to extract per-cue time ranges and whether each cue ends
 *  mid-sentence or at a clause boundary. Used to prefer "silence AT a sentence end" over just
 *  "any silence". */
async function parseSrt(srtPath: string): Promise<Cue[]> {
  if (!existsSync(srtPath)) return [];
  const raw = await readFile(srtPath, "utf8");
  const blocks = raw.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const out: Cue[] = [];
  for (const b of blocks) {
    const lines = b.split("\n");
    if (lines.length < 2) continue;
    const tsLine = lines[1]!;
    const m = /(\d\d):(\d\d):(\d\d),(\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d),(\d\d\d)/.exec(tsLine);
    if (!m) continue;
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
    const text = lines.slice(2).join(" ").trim();
    out.push({ startSec: start, endSec: end, endsAtSentence: SENTENCE_END_RE.test(text) });
  }
  return out;
}

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
 *  `${base}.snapped.mp4` and returns its path. On no silence found, returns inputPath unchanged.
 *  M8.5 — if `srtPath` is provided and exists, prefer silence boundaries that fall at the end of
 *  a sentence over arbitrary silences. */
export async function snapToSilence(inputPath: string, outDir: string, srtPath?: string): Promise<string> {
  const silences = await detectSilences(inputPath);
  // Current clip's real duration (from ffprobe — don't trust fine math).
  const probe = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath]);
  const dur = parseFloat(probe.stdout.trim());
  if (!dur || silences.length === 0) return inputPath;

  // M8.5 — parse sentence-end timestamps from the whisper SRT if we have one. A sentence-end
  // silence at the boundary is strictly preferable to a mid-sentence silence; we filter the
  // candidates to sentence-ends first and fall back to any silence if that set is empty.
  const cues = srtPath ? await parseSrt(srtPath) : [];
  const sentenceEnds = cues.filter((c) => c.endsAtSentence).map((c) => c.endSec);
  const sentenceStarts = cues.filter((c) => c.endsAtSentence).map((c) => c.endSec); // next cue starts after a sentence-end

  // Start-snap: the END of a silence range that's within [0, SEARCH_WINDOW_SEC].
  // That silence ended → speech began → good start point.
  let startCandidates = silences.filter((s) => s.end <= SEARCH_WINDOW_SEC).map((s) => s.end);
  // M8.5: prefer silences that align with a sentence boundary (within 0.3s).
  if (sentenceStarts.length) {
    const sentenceAligned = startCandidates.filter((t) => sentenceStarts.some((se) => Math.abs(se - t) < 0.3));
    if (sentenceAligned.length) startCandidates = sentenceAligned;
  }
  const startSec = startCandidates.length ? Math.max(...startCandidates) : 0;

  // End-snap: the START of a silence range that's within [dur - SEARCH_WINDOW_SEC, dur].
  // That silence started → speech ended → good end point.
  let endCandidates = silences.filter((s) => s.start >= dur - SEARCH_WINDOW_SEC).map((s) => s.start);
  if (sentenceEnds.length) {
    const sentenceAligned = endCandidates.filter((t) => sentenceEnds.some((se) => Math.abs(se - t) < 0.3));
    if (sentenceAligned.length) endCandidates = sentenceAligned;
  }
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
