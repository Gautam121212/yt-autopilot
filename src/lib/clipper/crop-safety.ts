/**
 * Clipper M6 — face-aware crop-safety for 9:16 verticals.
 *
 * Why rewritten: the M4 run shipped a clip (short_02) where the subject's face was sliced at the
 * left edge after a center-crop from a two-shot. The M5 cropdetect heuristic couldn't catch it —
 * "active content" filled the whole frame, so cropdetect called it safe; only face position
 * mattered. This module now runs real face detection (Mediapipe via Python, in CI) and makes
 * three decisions:
 *
 *   - SAFE center-crop: faces are present AND the dominant face center sits inside the center
 *     9:16 stripe in ≥75% of samples.
 *   - BLURRED-BG: faces are present but drift outside the stripe (letterbox would preserve them).
 *     Non-destructive — caller renders landscape centered on blurred-bg vertical canvas.
 *   - UNSAFE: either no faces at all AND the cropdetect heuristic also fails (B-roll or decor
 *     with no clear subject), OR too many scene cuts to keep continuity.
 *
 * We stop RECORDING clip failures as "crop-unsafe" the way M5 did; instead the processor picks
 * the right layout. The old rejection path is kept only for the no-signal case (unsafe == true).
 *
 * The Python script is `src/lib/clipper/py/face_scan.py`. It needs mediapipe + opencv on the
 * runner — the clip-pipeline workflow installs them in the process job.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

const SAMPLE_FPS = 1;                   // one frame per second — matches face_scan.py default
const CENTER_STRIPE_SAFE_RATIO = 0.75;  // ≥75% of face samples inside stripe → safe center-crop
const MAX_SCENE_CUTS = 5;               // more than this and tracking will jitter badly
const MIN_FACE_PRESENCE = 0.3;          // if <30% of samples have a face, treat as "no faces" clip
const SHIFTED_CROP_MAX_STD = 0.08;      // M9.1 — face x-std normalized ≤8% of width → safe to shift
const SHIFTED_CROP_MIN_OFFSET = 0.05;   // only shift if the median is >5% off center
const SHIFTED_CROP_MAX_OFFSET = 0.30;   // never shift so far the stripe falls off the frame edge

const PY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "py", "face_scan.py");

export type CropLayout = "center-crop" | "shifted-crop" | "blurred-bg" | "unsafe";

export type CropSafetyResult = {
  safeForCrop: boolean;                 // kept for API compat with M5 processor
  layout: CropLayout;                   // M6 — which assembly path the processor should use
  reason: string;
  samples: number;
  centeredSamples: number;
  centeredRatio: number;
  sceneCuts: number;
  // M6 face-scan fields
  framesWithFace: number;
  facesTotal: number;
  facePresenceRatio: number;
  dominantCenterXNorm: number;          // mean face-center x / width (0..1)
  /** M9.1 — crop x-center as a fraction of source width. 0.5 = center-crop, otherwise shift. */
  cropCenterXNorm: number;
};

async function dims(file: string): Promise<{ width: number; height: number }> {
  const r = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = r.stdout.trim().split(",").map(Number);
  return { width: w ?? 0, height: h ?? 0 };
}

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

/** Scene-cut probe reused from M5 — too many cuts mean the subject repositions and face-tracking
 *  of a static center stripe will jitter. */
async function sceneCutCount(file: string): Promise<number> {
  const { stderr } = await runCapture("ffmpeg", [
    "-nostats", "-i", file,
    "-vf", `select='gt(scene,0.4)',metadata=print:file=-`,
    "-f", "null", "-",
  ]);
  return (stderr.match(/scene_score=\d/g) ?? []).length;
}

type FaceScanSummary = {
  summary: true;
  samples: number;
  frames_with_face: number;
  faces_total: number;
  face_center_x_mean_norm: number;
  face_center_x_median_norm?: number;      // M9.1 — robust center estimate for shifted-crop
  face_center_x_std_norm: number;
  centered_ratio: number;
  /** M8.6: multi-subject signals. */
  multi_face_frames?: number;
  opposite_third_frames?: number;
  multi_face_ratio?: number;
  opposite_third_ratio?: number;
  width: number;
  height: number;
};

/** Call the Python face-scan script. Returns the summary line (last JSON on stdout). If the
 *  script fails (no mediapipe installed, no Python, etc.) returns null so the caller can fall
 *  back to the cropdetect heuristic. */
async function faceScan(file: string): Promise<FaceScanSummary | null> {
  try {
    const { stdout, code } = await runCapture("python3", [PY_SCRIPT, "--input", file, "--fps", String(SAMPLE_FPS)]);
    if (code !== 0) return null;
    const lines = stdout.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]!);
        if (obj.summary) return obj as FaceScanSummary;
      } catch { /* keep scanning */ }
    }
    return null;
  } catch { return null; }
}

/** Fallback: the old cropdetect heuristic for clips where face detection didn't run (python
 *  unavailable) or returned no faces. */
async function cropdetectFallback(file: string, width: number, height: number): Promise<{ centeredRatio: number; samples: number; centeredSamples: number }> {
  const cropWidth = Math.round(height * 9 / 16);
  const centerStripe = { xMin: Math.round((width - cropWidth) / 2), xMax: Math.round((width - cropWidth) / 2) + cropWidth };
  const { stderr } = await runCapture("ffmpeg", [
    "-nostats", "-i", file,
    "-vf", `fps=${SAMPLE_FPS},cropdetect=24:16:0`,
    "-f", "null", "-",
  ]);
  const cropRe = /crop=(\d+):(\d+):(\d+):(\d+)/g;
  const samples: Array<{ cx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = cropRe.exec(stderr))) {
    const w = Number(m[1]), x = Number(m[3]);
    samples.push({ cx: x + w / 2 });
  }
  if (!samples.length) return { centeredRatio: 0, samples: 0, centeredSamples: 0 };
  const centered = samples.filter((s) => s.cx >= centerStripe.xMin && s.cx <= centerStripe.xMax).length;
  return { centeredRatio: centered / samples.length, samples: samples.length, centeredSamples: centered };
}

export async function checkCropSafety(inputPath: string): Promise<CropSafetyResult> {
  const { width, height } = await dims(inputPath);
  if (!width || !height) {
    return {
      safeForCrop: false, layout: "unsafe", reason: "could not probe dimensions",
      samples: 0, centeredSamples: 0, centeredRatio: 0, sceneCuts: 0,
      framesWithFace: 0, facesTotal: 0, facePresenceRatio: 0, dominantCenterXNorm: 0, cropCenterXNorm: 0.5,
    };
  }

  // Portrait source already (phone footage) — no crop needed, always safe.
  if (height > width) {
    return {
      safeForCrop: true, layout: "center-crop", reason: "source already portrait",
      samples: 0, centeredSamples: 0, centeredRatio: 1, sceneCuts: 0,
      framesWithFace: 0, facesTotal: 0, facePresenceRatio: 0, dominantCenterXNorm: 0.5, cropCenterXNorm: 0.5,
    };
  }

  const cuts = await sceneCutCount(inputPath);
  const face = await faceScan(inputPath);

  if (face && face.samples > 0) {
    const presence = face.frames_with_face / face.samples;
    if (presence >= MIN_FACE_PRESENCE) {
      // M8.6 — multi-subject check. If ≥30% of frames show 2 faces separated by width/4+, or
      // ≥20% show faces at opposite thirds, center-crop WILL slice one of them. Force
      // blurred-bg so both stay visible, regardless of center-stripe ratio.
      const multiSubject = (face.multi_face_ratio ?? 0) >= 0.3 || (face.opposite_third_ratio ?? 0) >= 0.2;
      if (multiSubject) {
        return {
          safeForCrop: false, layout: "blurred-bg",
          reason: `multi-subject shot (${((face.multi_face_ratio ?? 0) * 100).toFixed(0)}% multi-face, ${((face.opposite_third_ratio ?? 0) * 100).toFixed(0)}% opposite-thirds); blurred-bg keeps both visible`,
          samples: face.samples, centeredSamples: Math.round(face.centered_ratio * face.faces_total),
          centeredRatio: face.centered_ratio, sceneCuts: cuts,
          framesWithFace: face.frames_with_face, facesTotal: face.faces_total,
          facePresenceRatio: presence, dominantCenterXNorm: face.face_center_x_mean_norm, cropCenterXNorm: 0.5,
        };
      }
      // Face-containing clip — the only honest signal is face position vs the center stripe.
      const centerSafe = face.centered_ratio >= CENTER_STRIPE_SAFE_RATIO;
      const notTooCutty = cuts <= MAX_SCENE_CUTS;
      if (centerSafe && notTooCutty) {
        return {
          safeForCrop: true, layout: "center-crop",
          reason: `faces centered in ${(face.centered_ratio * 100).toFixed(0)}% of samples, ${cuts} scene cuts`,
          samples: face.samples, centeredSamples: Math.round(face.centered_ratio * face.faces_total),
          centeredRatio: face.centered_ratio, sceneCuts: cuts,
          framesWithFace: face.frames_with_face, facesTotal: face.faces_total,
          facePresenceRatio: presence, dominantCenterXNorm: face.face_center_x_mean_norm, cropCenterXNorm: 0.5,
        };
      }
      // M9.1 — SHIFTED CROP. Faces are off-center-stripe BUT their median position is stable
      // (low x-std). We can shift the 9:16 crop stripe to the median x instead of width/2
      // and keep the subject centered without destroying anything. This handles the "subject
      // consistently off-center but not moving" case without needing dynamic pan-tracking.
      const medianX = face.face_center_x_median_norm ?? face.face_center_x_mean_norm;
      const stdX = face.face_center_x_std_norm;
      const offsetFromCenter = Math.abs(medianX - 0.5);
      const stable = stdX <= SHIFTED_CROP_MAX_STD;
      const shiftWorthIt = offsetFromCenter >= SHIFTED_CROP_MIN_OFFSET;
      const shiftFits = offsetFromCenter <= SHIFTED_CROP_MAX_OFFSET;
      if (stable && shiftWorthIt && shiftFits && notTooCutty) {
        return {
          safeForCrop: true, layout: "shifted-crop",
          reason: `faces stable at x≈${(medianX * 100).toFixed(0)}% (std ${(stdX * 100).toFixed(1)}%); shift crop stripe to match`,
          samples: face.samples, centeredSamples: Math.round(face.centered_ratio * face.faces_total),
          centeredRatio: face.centered_ratio, sceneCuts: cuts,
          framesWithFace: face.frames_with_face, facesTotal: face.faces_total,
          facePresenceRatio: presence, dominantCenterXNorm: face.face_center_x_mean_norm, cropCenterXNorm: medianX,
        };
      }
      // Faces present but neither centered nor stable-off-center — use blurred-bg layout.
      return {
        safeForCrop: false, layout: "blurred-bg",
        reason: `faces off-center and ${stable ? "shift too large/small" : `moving (std ${(stdX * 100).toFixed(1)}%)`}; blurred-bg preserves composition`,
        samples: face.samples, centeredSamples: Math.round(face.centered_ratio * face.faces_total),
        centeredRatio: face.centered_ratio, sceneCuts: cuts,
        framesWithFace: face.frames_with_face, facesTotal: face.faces_total,
        facePresenceRatio: presence, dominantCenterXNorm: face.face_center_x_mean_norm, cropCenterXNorm: 0.5,
      };
    }
  }

  // No face signal (B-roll, food shots, text cards) — fall back to cropdetect's "active content
  // position". A static center-crop is fine if content is already center-weighted; otherwise
  // blurred-bg.
  const cd = await cropdetectFallback(inputPath, width, height);
  if (cd.samples === 0) {
    return {
      safeForCrop: false, layout: "unsafe",
      reason: "no faces detected, cropdetect produced no samples",
      samples: 0, centeredSamples: 0, centeredRatio: 0, sceneCuts: cuts,
      framesWithFace: face?.frames_with_face ?? 0, facesTotal: face?.faces_total ?? 0,
      facePresenceRatio: 0, dominantCenterXNorm: 0, cropCenterXNorm: 0.5,
    };
  }
  const centerSafe = cd.centeredRatio >= CENTER_STRIPE_SAFE_RATIO;
  if (centerSafe && cuts <= MAX_SCENE_CUTS) {
    return {
      safeForCrop: true, layout: "center-crop",
      reason: `no faces but active content centered in ${(cd.centeredRatio * 100).toFixed(0)}% of samples`,
      samples: cd.samples, centeredSamples: cd.centeredSamples, centeredRatio: cd.centeredRatio, sceneCuts: cuts,
      framesWithFace: 0, facesTotal: 0, facePresenceRatio: 0, dominantCenterXNorm: 0.5, cropCenterXNorm: 0.5,
    };
  }
  return {
    safeForCrop: false, layout: "blurred-bg",
    reason: `no faces and active content off-center; use blurred-bg layout`,
    samples: cd.samples, centeredSamples: cd.centeredSamples, centeredRatio: cd.centeredRatio, sceneCuts: cuts,
    framesWithFace: 0, facesTotal: 0, facePresenceRatio: 0, dominantCenterXNorm: 0, cropCenterXNorm: 0.5,
  };
}
