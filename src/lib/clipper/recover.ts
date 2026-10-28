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
  // M11.5 — auto-editor renamed --silent-threshold in newer releases (trial #4 CI run failed
  // with "Unknown option: --silent-threshold"). Modern syntax: --edit audio:threshold=0.04.
  // The older flag is kept as a positional fallback in the catch below for older installs.
  const argsModern = ["--margin", "0.2sec", "--edit", "audio:threshold=0.04", "--no-open", inputPath, "--output", output];
  const argsLegacy = ["--margin", "0.2sec", "--silent-threshold", "0.04", "--no-open", inputPath, "--output", output];
  try {
    const r = await exec(autoEditorBin(), argsModern, { maxBuffer: 32 * 1024 * 1024 });
    return { inputPath, outputPath: output, stderr: r.stderr };
  } catch (e) {
    const msg = (e as Error).message;
    // Fallback 1: unknown-option on modern syntax → try legacy flag (older auto-editor).
    if (/Unknown option/i.test(msg)) {
      try {
        const r = await exec(autoEditorBin(), argsLegacy, { maxBuffer: 32 * 1024 * 1024 });
        return { inputPath, outputPath: output, stderr: r.stderr };
      } catch { /* fall through */ }
    }
    // Fallback 2: broken wrapper script but module works.
    if (/ENOENT|Permission denied|not found/i.test(msg)) {
      const r = await exec("python3", ["-m", "auto_editor", ...argsModern], { maxBuffer: 32 * 1024 * 1024 });
      return { inputPath, outputPath: output, stderr: r.stderr };
    }
    throw e;
  }
}
