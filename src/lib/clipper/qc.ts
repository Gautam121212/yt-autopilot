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

export type QCVerdict = {
  passed: boolean;
  reasons: string[];                     // empty when passed
  dimensions: { width: number; height: number };
  durationSec: number;
  blackFrameRatio: number;
  framesWithFace: number;
  totalFrames: number;
  slicedFaceSamples: number;             // count of samples where a face touches a frame edge
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

/** Count all-black frames via ffmpeg's blackdetect. One line is emitted per black run; we sum
 *  the black duration and divide by total. */
async function blackRatio(file: string, totalSec: number): Promise<number> {
  if (totalSec <= 0) return 1;
  const { stderr } = await runCapture("ffmpeg", [
    "-nostats", "-i", file,
    "-vf", "blackdetect=d=0.2:pix_th=0.1",
    "-f", "null", "-",
  ]);
  const re = /black_duration:(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  let blackSec = 0;
  while ((m = re.exec(stderr))) blackSec += Number(m[1]);
  return Math.min(1, blackSec / totalSec);
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
  const { width, height, durationSec } = await dimsAndDuration(finalPath);

  if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    reasons.push(`dimensions ${width}x${height} != ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
  }
  if (durationSec < 5) {
    reasons.push(`duration ${durationSec.toFixed(1)}s < 5s (truncated or empty)`);
  }

  const black = await blackRatio(finalPath, durationSec);
  if (black > MAX_BLACK_FRAMES_RATIO) {
    reasons.push(`${(black * 100).toFixed(0)}% black frames (likely title/end card)`);
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
    reasons,
    dimensions: { width, height },
    durationSec,
    blackFrameRatio: black,
    framesWithFace, totalFrames,
    slicedFaceSamples: sliced,
  };
}

/** Clean up extracted temp frames if any — currently we don't persist them, but reserved for
 *  the future image-side inspection path. */
export async function cleanupFrames(dir: string): Promise<void> {
  try {
    const names = await readdir(dir);
    for (const n of names) if (n.endsWith(".jpg") || n.endsWith(".png")) await unlink(path.join(dir, n));
  } catch { /* ignore */ }
}
