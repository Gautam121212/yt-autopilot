/**
 * Clipper M2 — assemble. Produces the final deliverable(s):
 *
 *   LONG format: concatenate chosen clips into one 7-15 min mp4. Each join uses a 400ms xfade on
 *   video + afade on audio so the cut doesn't sound like a splice. Horizontal 16:9 preserved.
 *
 *   SHORTS format: each chosen clip becomes its own 9:16 1080×1920 mp4, center-cropped from the
 *   source frame. No concatenation. The caller writes N files.
 *
 * Both paths re-encode once because the loudnorm pass earlier already changed the audio and the
 * crop/pad for vertical changes the video, so a stream-copy wouldn't apply.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Build one 1080×1920 vertical short from a 16:9 source. Center-crops to 9:16. */
export async function makeShort(inputPath: string, outDir: string, label: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, `short_${label}.mp4`);
  // crop filter: take a 9:16 slice from the center. For a 16:9 1080p source: target width = 1080 *
  // (9/16) = 607.5 → use the full height, crop width to (ih*9/16). Then scale to 1080x1920.
  await exec("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    "-vf", "crop=ih*9/16:ih,scale=1080:1920:flags=lanczos",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return output;
}

/** Concatenate clips with 400ms xfade + afade transitions into one long-form 16:9 mp4. The source
 *  clips should all be the same resolution/fps (they are — our extract step encoded them uniformly). */
export async function concatLong(clipPaths: string[], outDir: string, label = "long"): Promise<string> {
  if (clipPaths.length === 0) throw new Error("concatLong: no clips");
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, `long_${label}.mp4`);

  // Trivial case: one clip → just re-mux to standard container settings.
  if (clipPaths.length === 1) {
    await exec("ffmpeg", [
      "-y", "-v", "error", "-i", clipPaths[0]!,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      output,
    ], { maxBuffer: 32 * 1024 * 1024 });
    return output;
  }

  // Multi-clip: build an xfade chain. For N clips we need N-1 xfade transitions. Each xfade
  // needs the OFFSET into the current stream where the fade begins (previous-length - overlap).
  // We query each clip's duration via ffprobe and build the filtergraph.
  const durs: number[] = [];
  for (const c of clipPaths) {
    const r = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", c]);
    durs.push(parseFloat(r.stdout.trim()));
  }
  const overlap = 0.4;
  const parts: string[] = [];
  const inputs: string[] = [];
  clipPaths.forEach((c) => { inputs.push("-i", c); });

  // Build video chain: v0 xfade v1 → vxf1, vxf1 xfade v2 → vxf2, ...
  let vLabel = "0:v";
  let aLabel = "0:a";
  let runningSec = 0;
  for (let i = 1; i < clipPaths.length; i++) {
    const prevDur = i === 1 ? durs[0]! : (runningSec + durs[i - 1]! - overlap);
    runningSec = i === 1 ? durs[0]! - overlap : (prevDur);
    const offset = i === 1 ? durs[0]! - overlap : runningSec;
    parts.push(`[${vLabel}][${i}:v]xfade=transition=fade:duration=${overlap}:offset=${offset.toFixed(3)}[vx${i}]`);
    parts.push(`[${aLabel}][${i}:a]acrossfade=d=${overlap}[ax${i}]`);
    vLabel = `vx${i}`;
    aLabel = `ax${i}`;
  }

  await exec("ffmpeg", [
    "-y", "-v", "error",
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ], { maxBuffer: 64 * 1024 * 1024 });
  return output;
}

/** Write a plain-text manifest alongside the outputs so a future upload step can read the picks. */
export async function writeManifest(outDir: string, data: unknown): Promise<string> {
  const p = path.join(outDir, "manifest.json");
  await writeFile(p, JSON.stringify(data, null, 2));
  return p;
}
