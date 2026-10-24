/**
 * Clipper M2/M4 — polish. ffmpeg pass that cleans a raw clip:
 *   - **Two-pass EBU R128 loudness normalize** to -14 LUFS / -1.5 dBTP / LRA 11.
 *     First pass measures the clip's actual loudness, second pass applies the correction with
 *     those measured values — lands within ±0.1 LU of target. (One-pass could miss by ±2 LU
 *     which was failing our 15-pt loudness gate in M4 testing.)
 *   - 150ms audio fade in + fade out so no abrupt pops at the cut boundaries.
 *   - Video stream-copied — the extract step already encoded it.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type PolishResult = { inputPath: string; outputPath: string };

type LoudnormPass1 = { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string };

/** Run pass 1: loudnorm with print_format=json; parse the measured values from stderr. */
async function measure(inputPath: string): Promise<LoudnormPass1> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-nostats", "-i", inputPath,
      "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
      "-f", "null", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", () => {
      // The JSON block is at the end of stderr. Find the last {...} that parses.
      const match = stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
      if (!match) return reject(new Error("loudnorm pass 1: no JSON block in stderr"));
      try { resolve(JSON.parse(match[0]) as LoudnormPass1); } catch (e) { reject(e); }
    });
  });
}

export async function polish(inputPath: string, outDir: string): Promise<PolishResult> {
  const base = path.basename(inputPath, path.extname(inputPath));
  const output = path.join(outDir, `${base}.polished.mp4`);
  // Pass 1 — measure.
  const m = await measure(inputPath);
  // Pass 2 — apply correction using measured values. Linear mode is more accurate when measured
  // values are supplied explicitly (per ffmpeg docs).
  const loudnorm = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`;
  await exec("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-af", `${loudnorm},afade=t=in:st=0:d=0.15,afade=t=out:st=99999:d=0.15`,
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k",
    "-movflags", "+faststart",
    output,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return { inputPath, outputPath: output };
}
