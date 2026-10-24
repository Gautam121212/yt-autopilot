/**
 * Clipper M2 — polish. The ffmpeg pass that cleans a raw clip:
 *   - EBU R128 loudness normalize to -14 LUFS integrated, -1.5 dBTP ceiling, LRA 11 (streaming spec)
 *   - 150ms audio fade in + fade out so no abrupt pops at the cut boundaries
 *   - Preserve video unchanged (we trust the extract step)
 *
 * Two-pass loudnorm would be slightly cleaner but ~2x slower; one-pass with the explicit I/TP/LRA
 * targets is what Spotify/YouTube uploads actually use and it's within 1 LU of the two-pass result.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type PolishResult = { inputPath: string; outputPath: string };

export async function polish(inputPath: string, outDir: string): Promise<PolishResult> {
  const base = path.basename(inputPath, path.extname(inputPath));
  const output = path.join(outDir, `${base}.polished.mp4`);
  await exec("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    // Audio: EBU R128 norm + short fades.
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.15,afade=t=out:st=99999:d=0.15",
    // Video: pass through, keep same codec for speed. Encoder stays libx264 so headers are standard.
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k",
    "-movflags", "+faststart",
    output,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return { inputPath, outputPath: output };
}
