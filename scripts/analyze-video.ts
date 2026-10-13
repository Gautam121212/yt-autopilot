/**
 * Video analyzer — reverse-engineer a rendered video for the kind of defects the final review
 * blocks on (adjacent-frame duplicates, dark/underexposed frames, bad aspect ratio, missing audio).
 *
 * Not a replacement for the LLM review; a quick, offline, no-API check you can run on any mp4 to
 * get a numeric read on the obvious problems BEFORE paying a vision call. Pairs with scripts/scores.ts
 * (which looks at historical review verdicts); this one looks at a single file.
 *
 * Usage: `npm run analyze -- path/to/video.mp4`
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr.slice(0, 400)}`);
  return r.stdout;
}

type Probe = {
  durationSec: number;
  bitRateKbps: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
};

function probe(file: string): Probe {
  const fmtJson = sh("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(fmtJson) as {
    format: { duration: string; bit_rate: string };
    streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const video = j.streams.find((s) => s.codec_type === "video");
  const audio = j.streams.find((s) => s.codec_type === "audio");
  const [fnum, fden] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    durationSec: Number(j.format.duration ?? 0),
    bitRateKbps: Math.round(Number(j.format.bit_rate ?? 0) / 1000),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: fden ? fnum / fden : 0,
    hasAudio: Boolean(audio),
  };
}

/** Extract 1 frame every `everySec` seconds into a tempdir; return the dir and the frame count. */
function extractFrames(file: string, everySec = 2): { dir: string; count: number } {
  const dir = mkdtempSync(path.join(tmpdir(), "analyze-"));
  sh("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", `fps=1/${everySec}`, "-q:v", "4", path.join(dir, "frame-%04d.jpg")]);
  return { dir, count: readdirSync(dir).length };
}

/** Perceptual hash via ffmpeg's `signature` filter is heavy; use ssim between consecutive frames instead. */
function pairwiseSsim(dir: string): { pair: [string, string]; ssim: number }[] {
  const frames = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
  const out: { pair: [string, string]; ssim: number }[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = path.join(dir, frames[i - 1]!);
    const b = path.join(dir, frames[i]!);
    // ssim filter emits its verdict at ffmpeg's default log level — `-v error` would eat it, so
    // suppress the banner only. The verdict goes to stderr: `All:0.994 (...)`.
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"], { encoding: "utf8" });
    const m = /All:\s*([0-9.]+)/.exec(r.stderr);
    if (m) out.push({ pair: [frames[i - 1]!, frames[i]!], ssim: Number(m[1]) });
  }
  return out;
}

/** Mean luminance per frame — low values flag dark/underexposed frames. */
function brightnessPerFrame(dir: string): { frame: string; yavg: number }[] {
  const frames = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
  const out: { frame: string; yavg: number }[] = [];
  for (const f of frames) {
    // signalstats metadata goes to the printed `file=-` channel on STDOUT when we route it there.
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", path.join(dir, f), "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf8" });
    // metadata=print writes to the file we named; `file=-` means stdout. On some ffmpeg builds the
    // output lands in stderr instead. Check both.
    const haystack = r.stdout + "\n" + r.stderr;
    const m = /YAVG=([0-9.]+)/.exec(haystack);
    if (m) out.push({ frame: f, yavg: Number(m[1]) });
  }
  return out;
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error("usage: npm run analyze -- path/to/video.mp4"); process.exit(1); }
  if (!existsSync(file)) { console.error(`not found: ${file}`); process.exit(1); }

  const sizeBytes = statSync(file).size;
  console.log(`\n# Analysis — ${file}\n`);

  const p = probe(file);
  console.log("## Probe");
  console.log(`  duration     : ${p.durationSec.toFixed(1)}s`);
  console.log(`  bit rate     : ${p.bitRateKbps} kbps`);
  console.log(`  resolution   : ${p.width}x${p.height}  (fps ${p.fps.toFixed(0)})`);
  console.log(`  audio stream : ${p.hasAudio ? "yes" : "NO — final video should have narration"}`);
  console.log(`  file size    : ${(sizeBytes / 1_000_000).toFixed(2)} MB`);

  // Red flags from the probe alone
  const probeFlags: string[] = [];
  if (!p.hasAudio) probeFlags.push("no audio stream (narration missing)");
  if (p.width < 1280 || p.height < 720) probeFlags.push(`low resolution ${p.width}x${p.height} (expect ≥ 1280x720)`);
  if (Math.abs(p.width / p.height - 16 / 9) > 0.02 && Math.abs(p.width / p.height - 9 / 16) > 0.02) {
    probeFlags.push(`unusual aspect ratio ${(p.width / p.height).toFixed(2)}:1 (expected 16:9 or 9:16)`);
  }
  if (p.bitRateKbps < 500) probeFlags.push(`very low bit rate ${p.bitRateKbps} kbps (final renders are usually ≥ 2 Mbps)`);
  if (probeFlags.length) console.log(`\n  ⚠ ${probeFlags.join("\n  ⚠ ")}`);

  if (p.durationSec < 5) { console.log("\nToo short for frame-level analysis; stopping."); return; }

  const everySec = p.durationSec < 60 ? 2 : p.durationSec < 180 ? 3 : 5;
  console.log(`\n## Frame-level analysis (sampling every ${everySec}s)\n`);
  const { dir, count } = extractFrames(file, everySec);
  try {
    const ssim = pairwiseSsim(dir);
    const bright = brightnessPerFrame(dir);

    // SSIM ≥ 0.98 between consecutive sampled frames = essentially the same shot still on screen.
    // That's fine when the sample interval is small but is the exact "same photo repeated" pattern
    // the final review calls a MAJOR defect at scene scale.
    const dupes = ssim.filter((x) => x.ssim >= 0.98);
    const dark = bright.filter((x) => x.yavg < 25);

    console.log(`  sampled frames        : ${count}`);
    console.log(`  near-identical pairs  : ${dupes.length} of ${ssim.length}  (SSIM ≥ 0.98)`);
    console.log(`  dark frames (YAVG<25) : ${dark.length} of ${bright.length}`);

    if (dupes.length) {
      console.log("\n  Near-identical pairs (possible adjacent-shot duplication):");
      for (const d of dupes.slice(0, 8)) console.log(`    - ${d.pair[0]} ↔ ${d.pair[1]}  SSIM ${d.ssim.toFixed(3)}`);
      if (dupes.length > 8) console.log(`    (+ ${dupes.length - 8} more)`);
    }
    if (dark.length) {
      console.log("\n  Dark frames (may be mid-transition fade):");
      for (const d of dark.slice(0, 8)) console.log(`    - ${d.frame}  YAVG ${d.yavg.toFixed(1)}`);
      if (dark.length > 8) console.log(`    (+ ${dark.length - 8} more)`);
    }

    const summary: string[] = [];
    if (dupes.length / Math.max(1, ssim.length) > 0.3) summary.push(`${Math.round(100 * dupes.length / ssim.length)}% of sampled pairs are near-identical — this is the "same shot three times in a row" pattern the final review downrates`);
    if (dark.length / Math.max(1, bright.length) > 0.25) summary.push(`${Math.round(100 * dark.length / bright.length)}% of frames are dark — more than normal transition fade`);
    console.log(summary.length ? `\n## Verdict\n\n  ⚠ ${summary.join("\n  ⚠ ")}` : `\n## Verdict\n\n  ✓ no obvious frame-level defects.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
