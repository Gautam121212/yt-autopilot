/**
 * Clipper M7.4 — captions. Transcribe a polished clip with faster-whisper (Python, in CI),
 * write SRT, hand it back to the caller to burn in via ffmpeg's subtitles filter.
 *
 * We transcribe the POLISHED audio (post-loudnorm) not the raw because loudnorm occasionally
 * shifts speech timing by ~20ms when the alimiter engages — tiny but enough to desync subtitles.
 *
 * Burn-in happens in assemble.ts, not here, because the subtitles filter needs to be composed
 * with the crop/scale/attribution chain.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "py", "whisper_captions.py");

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

/** Transcribe the polished clip's audio and write an SRT alongside it. Returns the SRT path on
 *  success, null on failure (so caller can skip burn-in and still ship the clip without captions
 *  rather than failing the whole render). */
export async function transcribeToSRT(polishedPath: string, model = "base"): Promise<string | null> {
  const srt = polishedPath.replace(/\.(mp4|mov|mkv|webm)$/i, "") + ".srt";
  const r = await runCapture("python3", [PY_SCRIPT, "--input", polishedPath, "--out", srt, "--model", model]);
  if (r.code !== 0) {
    console.warn(`[captions] whisper failed (code=${r.code}): ${r.stderr.trim().split("\n").slice(0, 3).join(" | ")}`);
    return null;
  }
  if (!existsSync(srt)) {
    console.warn(`[captions] whisper exited 0 but no SRT at ${srt}`);
    return null;
  }
  return srt;
}
