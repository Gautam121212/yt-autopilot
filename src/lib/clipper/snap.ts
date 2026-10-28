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

const SEARCH_WINDOW_SEC = 5.0;      // M10.4: widened 2→5s so we can REACH a real sentence
const SILENCE_NOISE_DB = -30;       // what we count as "silence"
const SILENCE_MIN_SEC = 0.25;       // ignore clicks; need at least 250ms of continuous silence
const SENTENCE_END_RE = /[.!?](["')\]]*)\s*$/;
// M10.4: hook-starter cues — a cue begins a strong hook if its text starts with one of these.
// We prefer them for the start boundary over a plain sentence-start.
const HOOK_STARTER_RE = /^(so|now|watch|look|here|this|wait|okay|and then|first|if you|imagine|what if|the thing is|the problem|here['’]s|let me|guess what|you['’]ll never|turns out)\b/i;

type SilenceRange = { start: number; end: number };
type Cue = { startSec: number; endSec: number; text: string; endsAtSentence: boolean; isHookStart: boolean };

/** M8.5 + M10.4 — parse a whisper SRT file. Extract per-cue time ranges, sentence-end flag, and
 *  "is this cue a strong hook starter" flag (title-cased open, question start, or hook phrase).
 *  Used by snap to find clip boundaries that let a cold viewer understand the clip. */
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
    out.push({
      startSec: start, endSec: end, text,
      endsAtSentence: SENTENCE_END_RE.test(text),
      isHookStart: HOOK_STARTER_RE.test(text) || /^[A-Z]/.test(text),
    });
  }
  return out;
}

/** M10.4 — given the SRT, find candidate CLIP-START times within [earliest, latest]. A good
 *  start is where the current cue BEGINS a sentence AND is a hook-starter: a cold viewer walks
 *  in on a complete thought. If no hook-starters exist, we fall back to any sentence-start.
 *  Returns the LATEST such time (so we trim the most dead space without losing context). */
function pickSentenceStart(cues: Cue[], earliest: number, latest: number): number | null {
  // A cue "starts a sentence" if the previous cue ended with punctuation (or this is the first).
  const sentenceStarts: Array<{ t: number; isHook: boolean }> = [];
  for (let i = 0; i < cues.length; i++) {
    const prev = cues[i - 1];
    const cur = cues[i]!;
    const startsSentence = !prev || prev.endsAtSentence;
    if (startsSentence && cur.startSec >= earliest && cur.startSec <= latest) {
      sentenceStarts.push({ t: cur.startSec, isHook: cur.isHookStart });
    }
  }
  if (!sentenceStarts.length) return null;
  // Prefer hook-starters; among those (or all if none), take the LATEST — trims the most intro
  // without truncating meaning.
  const hooks = sentenceStarts.filter((s) => s.isHook);
  const pool = hooks.length ? hooks : sentenceStarts;
  return Math.max(...pool.map((s) => s.t));
}

/** M10.4 — pick the clip END within [earliest, latest]. A good end is where a cue ENDS a
 *  sentence — the viewer leaves on a complete thought, no mid-word cut, no dangling conjunction.
 *  Returns the EARLIEST valid end (so we don't tack on dead space after the payoff). */
function pickSentenceEnd(cues: Cue[], earliest: number, latest: number): number | null {
  const ends = cues
    .filter((c) => c.endsAtSentence && c.endSec >= earliest && c.endSec <= latest)
    .map((c) => c.endSec);
  if (!ends.length) return null;
  return Math.min(...ends);
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

/** Snap the clip's boundaries. Writes `${base}.snapped.mp4` and returns its path.
 *  Returns inputPath unchanged when snapping would hurt (no silence, too tight, etc).
 *
 *  M10.4 strategy — standalone-understanding first:
 *    1. If a whisper SRT exists: HARD-SNAP to sentence boundaries within ±5s. Start is picked
 *       as the LATEST sentence-start inside the window (trims intro fluff), preferring one that
 *       begins with a hook phrase. End is the EARLIEST sentence-end inside the window (lands on
 *       a complete thought, no trailing fluff).
 *    2. If no SRT (dense speech / music / missing whisper): fall back to the M8.5 silence-snap
 *       which prefers sentence-aligned silences.
 *    3. If neither works: return inputPath unchanged — no snap is better than a bad snap. */
export async function snapToSilence(inputPath: string, outDir: string, srtPath?: string): Promise<string> {
  const silences = await detectSilences(inputPath);
  const probe = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath]);
  const dur = parseFloat(probe.stdout.trim());
  if (!dur) return inputPath;

  const cues = srtPath ? await parseSrt(srtPath) : [];
  let startSec = 0;
  let endSec = dur;
  let strategy = "silence-only";

  // M10.4 — PRIMARY path: cue-driven sentence boundaries. Only engages when the SRT is
  // informative (≥3 cues, ≥1 sentence-end in each half of the search window).
  if (cues.length >= 3) {
    const startPick = pickSentenceStart(cues, 0, SEARCH_WINDOW_SEC);
    const endPick = pickSentenceEnd(cues, dur - SEARCH_WINDOW_SEC, dur);
    if (startPick !== null && endPick !== null && endPick - startPick >= 10) {
      startSec = startPick;
      endSec = endPick;
      strategy = "sentence-hard-snap";
    }
  }

  // FALLBACK — M8.5 silence snap biased toward sentence boundaries.
  if (strategy === "silence-only" && silences.length) {
    const sentenceEnds = cues.filter((c) => c.endsAtSentence).map((c) => c.endSec);
    const sentenceStarts = cues.filter((c, i) => (i === 0 || cues[i - 1]!.endsAtSentence)).map((c) => c.startSec);
    let startCandidates = silences.filter((s) => s.end <= SEARCH_WINDOW_SEC).map((s) => s.end);
    if (sentenceStarts.length) {
      const aligned = startCandidates.filter((t) => sentenceStarts.some((se) => Math.abs(se - t) < 0.3));
      if (aligned.length) startCandidates = aligned;
    }
    startSec = startCandidates.length ? Math.max(...startCandidates) : 0;
    let endCandidates = silences.filter((s) => s.start >= dur - SEARCH_WINDOW_SEC).map((s) => s.start);
    if (sentenceEnds.length) {
      const aligned = endCandidates.filter((t) => sentenceEnds.some((se) => Math.abs(se - t) < 0.3));
      if (aligned.length) endCandidates = aligned;
    }
    endSec = endCandidates.length ? Math.min(...endCandidates) : dur;
    strategy = "silence-biased";
  }

  console.log(`    [snap] strategy=${strategy} ${startSec.toFixed(2)}s → ${endSec.toFixed(2)}s (orig ${dur.toFixed(2)}s)`);

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
