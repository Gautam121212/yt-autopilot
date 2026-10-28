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
import { readFile } from "node:fs/promises";
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

/** M11.2 — speech-density signal. Sum of all SRT cue durations / clip duration. A value below
 *  0.4 means the clip is predominantly silence or music (gameplay compilation, ambient footage,
 *  B-roll loop) — a cold viewer has no narration to follow, so the clip fails the standalone-
 *  understanding bar. The processor uses this to reject such clips before snap/polish/render. */
export async function speechDensity(srtPath: string, clipDurationSec: number): Promise<number> {
  if (!existsSync(srtPath) || clipDurationSec <= 0) return 0;
  try {
    const raw = await readFile(srtPath, "utf8");
    const blocks = raw.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
    let speechSec = 0;
    for (const b of blocks) {
      const lines = b.split("\n");
      if (lines.length < 2) continue;
      const m = /(\d\d):(\d\d):(\d\d),(\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d),(\d\d\d)/.exec(lines[1]!);
      if (!m) continue;
      const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
      speechSec += Math.max(0, end - start);
    }
    return Math.min(1, speechSec / clipDurationSec);
  } catch { return 0; }
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
