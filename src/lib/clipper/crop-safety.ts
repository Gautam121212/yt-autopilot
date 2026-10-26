/**
 * Clipper M5 — crop-safety for 9:16 verticals. Simpler than face detection: use ffmpeg's
 * `cropdetect` filter to find the active content region of each ~1-second window, then measure
 * whether that region drifts outside the center 9:16 stripe (where a vertical crop will land).
 *
 * Heuristic (no CV deps):
 *   - sample 1 frame/sec via ffmpeg -vf "cropdetect=24:16:0"
 *   - parse `-vf 'crop=w:h:x:y'` suggestions from stderr
 *   - compute content center at each sample
 *   - if content center is horizontally outside the center 9:16 stripe (centered on frame center,
 *     width = height * 9/16) in more than 25% of samples, the clip is NOT crop-safe
 *   - also reject if there are >N "cut" scenes (via scenedetect) because cuts tend to
 *     reposition the subject
 *
 * Not as rigorous as face-tracking but zero-install and fast (~5s per clip). Catches the obvious
 * failures the user flagged — content hanging off the sides when forced into 9:16.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SAMPLE_FPS = 1;                   // one frame per second
const CROP_TOLERANCE_RATIO = 0.75;      // 75% of samples must have center-aligned content

export type CropSafetyResult = {
  safeForCrop: boolean;
  reason: string;
  samples: number;
  centeredSamples: number;
  centeredRatio: number;
  sceneCuts: number;
};

/** Probe source dimensions. */
async function dims(path: string): Promise<{ width: number; height: number }> {
  const r = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path]);
  const [w, h] = r.stdout.trim().split(",").map(Number);
  return { width: w ?? 0, height: h ?? 0 };
}

async function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", () => resolve(stderr));
  });
}

export async function checkCropSafety(inputPath: string): Promise<CropSafetyResult> {
  const { width, height } = await dims(inputPath);
  if (!width || !height) {
    return { safeForCrop: false, reason: "could not probe dimensions", samples: 0, centeredSamples: 0, centeredRatio: 0, sceneCuts: 0 };
  }
  // Target vertical crop width in the source: width will be height*9/16 if source is 16:9.
  const cropWidth = Math.round(height * 9 / 16);
  const centerStripe = { xMin: Math.round((width - cropWidth) / 2), xMax: Math.round((width - cropWidth) / 2) + cropWidth };

  // cropdetect at 1 fps + scenedetect in one pass (parses stderr).
  const stderr = await runCapture("ffmpeg", [
    "-nostats", "-i", inputPath,
    "-vf", `fps=${SAMPLE_FPS},cropdetect=24:16:0,select='gt(scene,0.4)',metadata=print:file=-`,
    "-f", "null", "-",
  ]);

  // Each cropdetect line looks like:
  //   [Parsed_cropdetect_0 @ 0x…] x1:0 x2:1919 y1:16 y2:1079 w:1920 h:1056 x:0 y:12 crop=1920:1056:0:12
  const cropRe = /crop=(\d+):(\d+):(\d+):(\d+)/g;
  const sceneRe = /scene_score=\d/g; // present when a cut was detected
  const samples: Array<{ cx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = cropRe.exec(stderr))) {
    const w = Number(m[1]), x = Number(m[3]);
    const cx = x + w / 2;
    samples.push({ cx });
  }
  const sceneCuts = (stderr.match(sceneRe) ?? []).length;

  if (!samples.length) {
    // No cropdetect output — unusual, treat as unsafe to be conservative.
    return { safeForCrop: false, reason: "cropdetect produced no samples", samples: 0, centeredSamples: 0, centeredRatio: 0, sceneCuts };
  }

  const centered = samples.filter((s) => s.cx >= centerStripe.xMin && s.cx <= centerStripe.xMax).length;
  const ratio = centered / samples.length;
  const safe = ratio >= CROP_TOLERANCE_RATIO && sceneCuts <= 5;

  const reason = !safe
    ? (ratio < CROP_TOLERANCE_RATIO
        ? `content center is outside the 9:16 stripe in ${((1 - ratio) * 100).toFixed(0)}% of samples`
        : `${sceneCuts} scene cuts (>5 threshold); subject likely repositions`)
    : "content stays within the 9:16 center stripe";

  return { safeForCrop: safe, reason, samples: samples.length, centeredSamples: centered, centeredRatio: ratio, sceneCuts };
}
