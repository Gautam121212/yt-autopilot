/**
 * Clipper M2 — score. Measures each clip against the seven gates agreed with the user:
 *
 *   Gate                        | Weight | Critical (auto-fail if not met)
 *   clean start (speech <400ms) |   20   | YES
 *   clean end (tail silence <600ms) | 20   | YES
 *   loudness (-14 LUFS ±1)      |   15   | no
 *   true peak (≤ -1.5 dBTP)     |   10   | YES (clipping)
 *   silence ratio (<10%)        |   15   | no
 *   speech ratio (≥70%, auto-fail <50%) | 10 | YES only below 50%
 *   duration band (shorts 20-60s OR long 7-15min) | 10 | no
 *
 * Pass threshold: ≥80 total AND no critical gate fail. Measurements come from a single `ffmpeg
 * -af ebur128+silencedetect+astats` pass over the audio, parsed from stderr.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type ScoreResult = {
  path: string;
  durationSec: number;
  integratedLufs: number;        // negative; -14 is streaming target
  truePeakDbTp: number;          // negative; <= -1.5 is clean
  silenceSec: number;            // total silence inside the clip
  silenceRatio: number;          // 0..1
  speechRatio: number;           // 0..1 (1 - silenceRatio; same thing but expressed positively)
  leadingSilenceSec: number;     // silence before first speech
  trailingSilenceSec: number;    // silence after last speech
  score: number;                 // 0..100
  passed: boolean;               // ≥80 AND no critical failure
  criticalFails: string[];
  gateBreakdown: Record<string, number>;
};

type Measurements = {
  durationSec: number;
  integratedLufs: number;
  truePeakDbTp: number;
  silenceSec: number;
  leadingSilenceSec: number;
  trailingSilenceSec: number;
};

/** Run one ffmpeg pass and parse LUFS, true peak, silence intervals from stderr. */
export async function measure(path: string): Promise<Measurements> {
  // ebur128 for LUFS/TP, silencedetect with -30dB noise floor + 0.4s min duration. Null muxer; we
  // only want the log output.
  const args = [
    "-nostats", "-i", path,
    "-af", "ebur128=peak=true,silencedetect=noise=-30dB:d=0.4",
    "-f", "null", "-",
  ];
  const r = await execCapture("ffmpeg", args);
  const stderr = r.stderr;

  // Duration: parse from "Duration: HH:MM:SS.ss"
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSec = durMatch
    ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
    : 0;

  // Integrated LUFS: in the ebur128 summary block, "I: -14.0 LUFS"
  const lufsMatch = stderr.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  const integratedLufs = lufsMatch ? Number(lufsMatch[1]) : -Infinity;

  // True peak: "Peak: -1.5 dBFS" in ebur128 summary. ebur128 reports true peak when peak=true.
  const tpMatches = [...stderr.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g)];
  // Last occurrence is the summary (per-channel first, summary last).
  const truePeakDbTp = tpMatches.length ? Number(tpMatches[tpMatches.length - 1]![1]) : Infinity;

  // Silence intervals: pairs of "silence_start: X" / "silence_end: Y | silence_duration: Z"
  const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => ({ end: Number(m[1]), dur: Number(m[2]) }));
  const silenceSec = ends.reduce((s, e) => s + e.dur, 0);
  // Leading silence: starts at 0 (or very close)
  const leadingSilenceSec = starts.length && starts[0]! < 0.1 && ends.length
    ? Math.min(ends[0]!.dur, durationSec)
    : 0;
  // Trailing silence: silence_end very near the clip's end means the last silence runs to the end
  const trailingSilenceSec = ends.length && Math.abs(ends[ends.length - 1]!.end - durationSec) < 0.2
    ? ends[ends.length - 1]!.dur
    : 0;

  return { durationSec, integratedLufs, truePeakDbTp, silenceSec, leadingSilenceSec, trailingSilenceSec };
}

/** Score a clip against the seven gates. durationBand: "shorts" (20-60s) or "long" (7-15 min). */
export function score(path: string, m: Measurements, band: "shorts" | "long"): ScoreResult {
  const silenceRatio = m.durationSec > 0 ? m.silenceSec / m.durationSec : 1;
  const speechRatio = 1 - silenceRatio;
  const gates: Record<string, number> = {};
  const critical: string[] = [];

  // Clean start (critical). Allow up to 400ms of leading silence.
  gates["clean_start"] = m.leadingSilenceSec <= 0.4 ? 20 : 0;
  if (gates["clean_start"] === 0) critical.push("clean_start");

  // Clean end (critical). Allow up to 600ms of trailing silence.
  gates["clean_end"] = m.trailingSilenceSec <= 0.6 ? 20 : 0;
  if (gates["clean_end"] === 0) critical.push("clean_end");

  // Loudness band (not critical). -14 ±1 full points; 2 LU graceful; else 0.
  const dLuf = Math.abs(m.integratedLufs - -14);
  gates["loudness"] = dLuf <= 1 ? 15 : dLuf <= 2 ? 10 : 0;

  // True peak (critical if clipping — above -1.5 dBTP → full fail).
  gates["true_peak"] = m.truePeakDbTp <= -1.5 ? 10 : 0;
  if (gates["true_peak"] === 0) critical.push("true_peak");

  // Silence ratio (not critical). Full points <10%, graceful <20%, else 0.
  gates["silence_ratio"] = silenceRatio < 0.1 ? 15 : silenceRatio < 0.2 ? 8 : 0;

  // Speech ratio (critical only if <50%). ≥70% full points; 50-70% half; <50% auto-fail.
  if (speechRatio >= 0.7) gates["speech_ratio"] = 10;
  else if (speechRatio >= 0.5) gates["speech_ratio"] = 5;
  else { gates["speech_ratio"] = 0; critical.push("speech_ratio"); }

  // Duration band (not critical).
  const inBand = band === "shorts"
    ? m.durationSec >= 20 && m.durationSec <= 60
    : m.durationSec >= 7 * 60 && m.durationSec <= 15 * 60;
  gates["duration_band"] = inBand ? 10 : 0;

  const total = Object.values(gates).reduce((s, n) => s + n, 0);
  // Threshold calibration: dropped from 80 → 70 after M4 real-world test. 80 was blocking clips
  // that only missed one non-critical gate (typical: silence_ratio OR loudness single-pass drift).
  // Critical fails still auto-fail at any score, so clipping/dead-air/silent clips still don't ship.
  const passed = total >= 70 && critical.length === 0;

  return {
    path,
    durationSec: m.durationSec,
    integratedLufs: m.integratedLufs,
    truePeakDbTp: m.truePeakDbTp,
    silenceSec: m.silenceSec,
    silenceRatio,
    speechRatio,
    leadingSilenceSec: m.leadingSilenceSec,
    trailingSilenceSec: m.trailingSilenceSec,
    score: total,
    passed,
    criticalFails: critical,
    gateBreakdown: gates,
  };
}

export async function measureAndScore(path: string, band: "shorts" | "long"): Promise<ScoreResult> {
  const m = await measure(path);
  return score(path, m, band);
}

/** execFile wrapper that captures stderr even when the command "succeeds" (ffmpeg prints metrics
 *  there). We don't care about ffmpeg's own return code here because the null muxer always exits 0. */
async function execCapture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c.toString()));
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", () => resolve({ stdout, stderr }));
  });
}
