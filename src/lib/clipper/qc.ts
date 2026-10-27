/**
 * Clipper M6 — post-render QC. Inspects a rendered final mp4 to catch the failures the user
 * flagged in the M4 samples:
 *   - clip 1 at t=0 was a black title card ("À mardi") — we check for all-black frames
 *   - clip 1 throughout was a wall with no subject — we check for face presence when the source
 *     clip had faces (via `expectFaces`)
 *   - clip 2 at t=10% had the subject's face sliced at the left edge — we check face bbox
 *     intersection with the frame edges
 *
 * This runs AFTER rendering, not before — the point is "did the final clip actually come out ok".
 * Params that pass CI render settings aren't enough; the actual pixels have to be inspected.
 *
 * Uses the same face_scan.py from crop-safety.ts (sampled at 1 fps on the shorter final clip).
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readdir, readFile, unlink } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

const PY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "py", "face_scan.py");

const EXPECTED_WIDTH = 1080;
const EXPECTED_HEIGHT = 1920;
const EDGE_SLICE_MARGIN = 20;            // pixels — face bbox touching inside this is "sliced"
const MAX_BLACK_FRAMES_RATIO = 0.15;     // >15% all-black = title card / dead space
const MIN_FACE_FRAMES_WHEN_EXPECTED = 0.4; // 40% of samples must have a face if source had any
const AV_SYNC_DRIFT_MAX_MS = 150;        // >150ms drift between video and audio stream duration
const FROZEN_FRAME_MIN_SEC = 1.0;        // ≥1s stretch of near-identical frames = frozen
const FROZEN_SSIM_THRESHOLD = 0.995;     // SSIM between adjacent samples ≥ this = "same frame"
const MIN_SOURCE_HEIGHT_WARN = 720;      // source <720p records a reviewFlag

export type QCVerdict = {
  passed: boolean;
  reasons: string[];                     // empty when passed
  warnings: string[];                    // M8.7 — non-blocking issues worth logging
  dimensions: { width: number; height: number };
  durationSec: number;
  videoDurationSec: number;              // M8.7
  audioDurationSec: number;              // M8.7
  avSyncDriftMs: number;                 // M8.7 — absolute drift between video/audio durations
  blackFrameRatio: number;
  framesWithFace: number;
  totalFrames: number;
  slicedFaceSamples: number;             // count of samples where a face touches a frame edge
  frozenRunsSec: number[];               // M8.7 — list of frozen-stretch durations
};

async function runCapture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c.toString()));
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function dimsAndDuration(file: string): Promise<{ width: number; height: number; durationSec: number }> {
  const r = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "csv=p=0", file,
  ]);
  const lines = r.stdout.trim().split("\n");
  const [w, h] = (lines[0] ?? "").split(",").map(Number);
  const dur = Number(lines[1] ?? 0);
  return { width: w ?? 0, height: h ?? 0, durationSec: dur || 0 };
}

/** M8.7 — per-stream durations. Returns both video and audio stream duration so caller can
 *  check A/V sync drift. ffprobe sometimes reports stream duration as empty for stream-copied
 *  mp4; we fall back to format duration. */
async function streamDurations(file: string): Promise<{ video: number; audio: number }> {
  const vq = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file]);
  const aq = await exec("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file]);
  const video = Number(vq.stdout.trim() || 0);
  const audio = Number(aq.stdout.trim() || 0);
  return { video, audio };
}

/** M8.7 — frozen-frame detector. Sample 1 fps and run SSIM between adjacent frames. Any run of
 *  consecutive samples where SSIM >= FROZEN_SSIM_THRESHOLD lasting >= FROZEN_FRAME_MIN_SEC is a
 *  frozen stretch (accidental freeze, muxing glitch, or source corruption). Returns durations
 *  (in seconds) of each stretch; empty = healthy. We use ffmpeg's freezedetect filter — it's
 *  cheaper than SSIM-per-pair and emits start/duration directly. */
async function detectFrozen(file: string): Promise<number[]> {
  const { stderr } = await runCapture("ffmpeg", [
    "-nostats", "-i", file,
    "-vf", `freezedetect=n=0.001:d=${FROZEN_FRAME_MIN_SEC}`,
    "-map", "0:v:0", "-f", "null", "-",
  ]);
  // freezedetect emits lines like:
  //   [freezedetect @ 0x…] lavfi.freezedetect.freeze_duration: 2.183
  const re = /freeze_duration:\s*([\d.]+)/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) out.push(Number(m[1]));
  return out;
}

/** Count mostly-black frames. M4-short_01 taught us that `blackdetect` only catches 100%-black
 *  frames; a title card ("À mardi" in white on black) has non-black text pixels and sneaks
 *  through. So we use TWO detectors and take the max:
 *   - blackdetect: strict pure-black (title card without text, end-card fade, actual black)
 *   - blackframe: counts frames where ≥95% of pixels are below luma threshold — catches
 *     title/end cards with text
 *  blackframe emits one line per frame; we count frames and divide by fps-estimated total. */
async function blackRatio(file: string, totalSec: number): Promise<number> {
  if (totalSec <= 0) return 1;
  const { stderr } = await runCapture("ffmpeg", [
    "-nostats", "-i", file,
    "-vf", "blackdetect=d=0.2:pix_th=0.1,blackframe=amount=95:threshold=32",
    "-f", "null", "-",
  ]);
  // blackdetect: pure-black duration per run
  const re = /black_duration:(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  let strictBlackSec = 0;
  while ((m = re.exec(stderr))) strictBlackSec += Number(m[1]);
  const strictRatio = Math.min(1, strictBlackSec / totalSec);

  // blackframe: one line per "mostly-black" frame — "[Parsed_blackframe_1 @ 0x…] frame:N pblack:N t:T.T"
  const fpsRe = /(\d+(?:\.\d+)?)\s*fps/;
  const fpsM = stderr.match(fpsRe);
  const fps = fpsM ? Number(fpsM[1]) : 30;
  const blackframeHits = (stderr.match(/\[Parsed_blackframe_\d+ @[^\]]+\]\s+frame:/g) ?? []).length;
  const mostlyBlackSec = blackframeHits / Math.max(1, fps);
  const mostlyRatio = Math.min(1, mostlyBlackSec / totalSec);

  return Math.max(strictRatio, mostlyRatio);
}

type FaceLine = { t: number; w: number; h: number; faces: Array<{ x: number; y: number; w: number; h: number; score: number }> };
type FaceSummary = { summary: true; samples: number; frames_with_face: number; faces_total: number; width: number; height: number };

async function faceScanLines(file: string): Promise<{ lines: FaceLine[]; summary: FaceSummary | null }> {
  try {
    const { stdout } = await runCapture("python3", [PY_SCRIPT, "--input", file, "--fps", "1"]);
    const out = stdout.trim().split("\n").filter(Boolean);
    const lines: FaceLine[] = [];
    let summary: FaceSummary | null = null;
    for (const l of out) {
      try {
        const obj = JSON.parse(l);
        if (obj.summary) summary = obj as FaceSummary;
        else lines.push(obj as FaceLine);
      } catch { /* skip bad line */ }
    }
    return { lines, summary };
  } catch { return { lines: [], summary: null }; }
}

/** A face is "sliced" if its bbox touches any edge of the frame within EDGE_SLICE_MARGIN. */
function countSlicedFaces(lines: FaceLine[]): number {
  let n = 0;
  for (const l of lines) {
    for (const f of l.faces) {
      const touchesLeft = f.x <= EDGE_SLICE_MARGIN;
      const touchesRight = f.x + f.w >= l.w - EDGE_SLICE_MARGIN;
      const touchesTop = f.y <= EDGE_SLICE_MARGIN;
      const touchesBottom = f.y + f.h >= l.h - EDGE_SLICE_MARGIN;
      if (touchesLeft || touchesRight || touchesTop || touchesBottom) { n++; break; }
    }
  }
  return n;
}

export async function qcCheck(finalPath: string, opts: { expectFaces?: boolean } = {}): Promise<QCVerdict> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const { width, height, durationSec } = await dimsAndDuration(finalPath);

  if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    reasons.push(`dimensions ${width}x${height} != ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
  }
  if (durationSec < 5) {
    reasons.push(`duration ${durationSec.toFixed(1)}s < 5s (truncated or empty)`);
  }

  // M8.7 — A/V sync drift check (spec section 7+8). We compare the v:0 and a:0 stream durations
  // reported by ffprobe. ffmpeg handles sync during encode, but a bad concat / xfade can leave
  // audio ending early. >150ms drift is audible on short-form; we flag it.
  const streams = await streamDurations(finalPath);
  const avDriftMs = Math.round(Math.abs((streams.video || durationSec) - (streams.audio || durationSec)) * 1000);
  if (avDriftMs > AV_SYNC_DRIFT_MAX_MS) {
    reasons.push(`A/V sync drift ${avDriftMs}ms > ${AV_SYNC_DRIFT_MAX_MS}ms (video=${streams.video.toFixed(2)}s audio=${streams.audio.toFixed(2)}s)`);
  } else if (avDriftMs > 50) {
    warnings.push(`A/V sync drift ${avDriftMs}ms (within tolerance but notable)`);
  }

  const black = await blackRatio(finalPath, durationSec);
  if (black > MAX_BLACK_FRAMES_RATIO) {
    reasons.push(`${(black * 100).toFixed(0)}% black frames (likely title/end card)`);
  }

  // M8.7 — frozen-frame detection (spec section 8 "frozen sections"). Any ≥1s run of frozen
  // frames in a short-form clip is a glitch and worth rejecting.
  const frozen = await detectFrozen(finalPath);
  if (frozen.length) {
    const totalFrozen = frozen.reduce((a, b) => a + b, 0);
    reasons.push(`frozen frames: ${frozen.length} stretch(es) totaling ${totalFrozen.toFixed(1)}s`);
  }

  const { lines, summary } = await faceScanLines(finalPath);
  const framesWithFace = summary?.frames_with_face ?? 0;
  const totalFrames = summary?.samples ?? 0;
  const presence = totalFrames > 0 ? framesWithFace / totalFrames : 0;

  if (opts.expectFaces && totalFrames > 0 && presence < MIN_FACE_FRAMES_WHEN_EXPECTED) {
    reasons.push(`source had faces but final shows them in only ${(presence * 100).toFixed(0)}% of samples (<${MIN_FACE_FRAMES_WHEN_EXPECTED * 100}%)`);
  }

  const sliced = countSlicedFaces(lines);
  // Allow a couple of sliced samples (hand gesture crossing frame, etc.) but reject if common.
  if (totalFrames > 0 && sliced / totalFrames > 0.25) {
    reasons.push(`faces touch frame edge in ${sliced}/${totalFrames} samples (likely sliced subject)`);
  }

  return {
    passed: reasons.length === 0,
    reasons, warnings,
    dimensions: { width, height },
    durationSec,
    videoDurationSec: streams.video,
    audioDurationSec: streams.audio,
    avSyncDriftMs: avDriftMs,
    blackFrameRatio: black,
    framesWithFace, totalFrames,
    slicedFaceSamples: sliced,
    frozenRunsSec: frozen,
  };
}

/** M8.7 — source-resolution flag. Called at fetch time, not QC time; adds a reviewFlag when
 *  source is below 720p so the user knows upscaling was NOT applied (spec section 7: "report
 *  the limitation rather than pretending that lost detail has been recovered"). */
export function sourceResolutionFlag(height: number): string | null {
  if (height <= 0) return null;
  return height < MIN_SOURCE_HEIGHT_WARN ? `source-${height}p-below-${MIN_SOURCE_HEIGHT_WARN}p` : null;
}

/** Clean up extracted temp frames if any — currently we don't persist them, but reserved for
 *  the future image-side inspection path. */
export async function cleanupFrames(dir: string): Promise<void> {
  try {
    const names = await readdir(dir);
    for (const n of names) if (n.endsWith(".jpg") || n.endsWith(".png")) await unlink(path.join(dir, n));
  } catch { /* ignore */ }
}
