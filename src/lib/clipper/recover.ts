/**
 * Clipper M2 — recover. When a polished clip fails the gates (bad start, filler-heavy middle,
 * trail-off end), run auto-editor on it. auto-editor's defaults do a lot: silence cut, head/tail
 * trim, cadence smoothing — all via ffmpeg under the hood.
 *
 * The binary is resolved from AUTO_EDITOR_BIN or PATH ("auto-editor"). On CI (Linux, Python 3.11)
 * the plain `auto-editor` on PATH works; on macOS pre-release Python 3.15 the wrapper may be broken,
 * so we probe stderr and fall back to re-running via `python3 -m auto_editor`.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type RecoverResult = { inputPath: string; outputPath: string; stderr: string };

function autoEditorBin(): string {
  return process.env.AUTO_EDITOR_BIN || "auto-editor";
}

export async function recover(inputPath: string, outDir: string): Promise<RecoverResult> {
  const base = path.basename(inputPath, path.extname(inputPath));
  const output = path.join(outDir, `${base}.recovered.mp4`);
  // auto-editor flags:
  //   --margin 0.2sec  → keep 200ms around each kept segment so words aren't clipped mid-syllable
  //   --silent-threshold 0.04 → audio under 4% is treated as silent (default-ish, works well on speech)
  //   --no-open → don't try to open the result in a player
  //   --output <path>
  const args = ["--margin", "0.2sec", "--silent-threshold", "0.04", "--no-open", inputPath, "--output", output];
  try {
    const r = await exec(autoEditorBin(), args, { maxBuffer: 32 * 1024 * 1024 });
    return { inputPath, outputPath: output, stderr: r.stderr };
  } catch (e) {
    const msg = (e as Error).message;
    // Fallback: some installs have a broken wrapper script but the module itself works.
    if (/ENOENT|Permission denied|not found/i.test(msg)) {
      const r = await exec("python3", ["-m", "auto_editor", ...args], { maxBuffer: 32 * 1024 * 1024 });
      return { inputPath, outputPath: output, stderr: r.stderr };
    }
    throw e;
  }
}
