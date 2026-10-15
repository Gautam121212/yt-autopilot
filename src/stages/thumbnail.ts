import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChannelConfig } from "../config";
import { ROOT } from "../config";
import { durationSec, sh } from "../lib/media";
import { commonsImage, openverseImage, pexelsImage, pixabayImage } from "../lib/sources";

const FONTS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial Bold.ttf",
];
const ACCENT = "0xFFC83D";     // hot yellow — reads at phone size
const isVideoFile = (f: string) => /\.(mp4|mov|webm)$/i.test(f);

let drawtext: boolean | undefined;
async function hasDrawtext(): Promise<boolean> {
  if (drawtext === undefined) {
    drawtext = await sh("ffmpeg", ["-hide_banner", "-filters"]).then((o) => /^\s*\S+\s+drawtext\s/m.test(o), () => false);
    if (!drawtext) console.warn('⚠️  This ffmpeg has no "drawtext"; thumbnail will have no text. Fix: brew install ffmpeg-full');
  }
  return drawtext;
}
async function firstFont(): Promise<string | null> {
  for (const f of FONTS) if (await fs.access(f).then(() => true, () => false)) return f;
  return null;
}

// Everyday words allowed in thumbnail text without appearing in the script.
const COMMON = new Set(["the","a","an","and","or","but","of","in","on","to","for","with","from","by","at","is","was",
  "this","that","how","why","what","when","where","who","not","no","never","always","all","one","two","first","last",
  "new","old","big","huge","tiny","real","true","best","worst","most","more","less","problem","mystery","secret",
  "story","truth","reason","answer","question","inside","behind","before","after","almost","nearly","still","yet",
  "working","broken","missing","hidden","lost","found","built","made","saved","killed","changed","failed","fixed",
  "impossible","possible","simple","strange","wrong","right","safe","cost","price","years","days","ways",
  "he","she","they","it","did","does","drank","ate","wrong","anyway","somehow","apparently","obviously","on","purpose"]);

function stem(w: string): string {
  const x = w.toLowerCase();
  for (const suf of ["ies", "ing", "ed", "es", "s"]) {
    if (x.endsWith(suf) && x.length - suf.length >= 4) return suf === "ies" ? `${x.slice(0, -3)}y` : x.slice(0, -suf.length);
  }
  return x;
}

/** Thumbnail text must be words the script uses (or everyday words) — catches invented or garbled text. */
export function safeThumbnailText(proposed: string, title: string, narration: string): string {
  const vocab = new Set((`${title} ${narration}`.toLowerCase().replace(/-/g, " ").match(/[a-z0-9']+/g) ?? []).map(stem));
  const words = proposed.match(/[A-Za-z0-9']+/g) ?? [];
  const known = (w: string) => /^[0-9]/.test(w) || w.length <= 3 || COMMON.has(w.toLowerCase()) || vocab.has(stem(w));
  if (words.length && words.length <= 5 && words.every(known)) return proposed;

  const t = (title.match(/[A-Za-z0-9'-]+/g) ?? []).map((w) => w.replace(/-$/, ""));
  const keep = t.filter((w) => /^[0-9]/.test(w) || (w.length > 4 && !COMMON.has(w.toLowerCase())));
  return keep.slice(0, 3).join(" ") || title.split(/\s+/).slice(0, 3).join(" ");
}

/**
 * Comedy-thumbnail layout: subject cropped tight and pushed hard, then a bold caption block in the
 * lower-left — white first line, accent-yellow payoff line, thick black outline so it survives at
 * phone size. No slide, no centred serif, no subtlety.
 */
/**
 * Picks the most striking frame from the finished video.
 *
 * ffmpeg's `thumbnail` filter scores frames against their neighbours and returns the most
 * representative of a batch — the standard way to avoid a transition, a fade or a dull frame.
 * Sampling from the first 70% of the runtime keeps the kicker unspoiled.
 */
export async function bestFrameFrom(videoPath: string, dir: string): Promise<string | null> {
  const total = await durationSec(videoPath).catch(() => 0);
  if (total < 5) return null;
  const candidates: string[] = [];
  // three windows across the video, one representative frame each
  for (const [i, at] of [0.12, 0.33, 0.58].entries()) {
    const out = path.join(dir, `frame-cand-${i}.jpg`);
    const ok = await sh("ffmpeg", [
      "-y", "-ss", String(Math.round(total * at)), "-t", "12", "-i", videoPath,
      "-vf", "thumbnail=90", "-frames:v", "1", "-q:v", "2", out,
    ]).then(() => true, () => false);
    // A clean exit does not prove a frame was written (a window past the end writes nothing): check
    // the file, or a thumbnail gets built from a path that does not exist — the #56 failure class.
    if (ok && (await fs.stat(out).then((st) => st.size > 1000, () => false))) candidates.push(out);
  }
  if (!candidates.length) return null;

  // Prefer the frame with the most going on. `metadata=print:file=-` puts the stats on stdout,
  // where we can actually read them — printing to stderr is what made this silently pick black frames.
  let best = { file: candidates[0]!, score: -1 };
  for (const f of candidates) {
    const out = await sh("ffmpeg", ["-v", "error", "-i", f, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"]).catch(() => "");
    const yavg = Number(/YAVG=([0-9.]+)/.exec(out)?.[1] ?? 0);
    const ylow = Number(/YLOW=([0-9.]+)/.exec(out)?.[1] ?? 0);
    const yhigh = Number(/YHIGH=([0-9.]+)/.exec(out)?.[1] ?? 0);
    // mid-brightness plus a wide tonal range = a frame with a subject in it, not a flat wall
    const exposure = 1 - Math.abs(yavg - 125) / 125;
    const range = (yhigh - ylow) / 255;
    const score = exposure + range;
    console.log(`  thumbnail candidate ${path.basename(f)}: brightness ${yavg.toFixed(0)}, range ${(range * 100).toFixed(0)}% -> ${score.toFixed(2)}`);
    if (score > best.score) best = { file: f, score };
  }
  return best.file;
}

/**
 * Thumbnail via Remotion's `still` command. Renders the Thumbnail composition (OpenMontage +
 * Apple-design typography/material) to a single JPG. Keeps the old ffmpeg background pipeline
 * (best-frame extraction + grading) because the composition only draws the overlay — the
 * background image is still the yt-autopilot best-frame pick.
 *
 * Returns null if the still render fails or if the composer isn't installed. Caller falls back
 * to the ffmpeg path, same shape as render.ts's Phase 3 fallback.
 */
async function makeThumbnailRemotion(bgSrc: string, text: string, out: string): Promise<string | null> {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const split = words.length >= 4 ? Math.ceil(words.length / 2) : words.length > 1 ? words.length - 1 : 1;
  const line1 = words.slice(0, split).join(" ");
  const line2 = words.slice(split).join(" ");

  const composerDir = path.join(ROOT, "remotion-composer");
  // Stage the bg image into public/ so Chromium can load it over Remotion's HTTP origin.
  // Same reason as render.ts' stage step: `file://` URLs are refused when the page is served
  // from `http://`. The thumb stage dir is per-video and wiped on each render.
  const runId = path.basename(path.dirname(out));
  const stageDir = path.join(composerDir, "public", `thumb-${runId}`);
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  const stagedBase = path.basename(bgSrc);
  const stagedPath = path.join(stageDir, stagedBase);
  try { await fs.symlink(bgSrc, stagedPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const stagedBgSrc = `thumb-${runId}/${stagedBase}`;

  const propsFile = path.join(path.dirname(out), "thumbnail-props.json");
  await fs.writeFile(propsFile, JSON.stringify({ bgSrc: stagedBgSrc, line1, line2 }));

  const args = [
    "remotion", "still", "src/index.tsx", "Thumbnail", out,
    "--props", propsFile,
    "--image-format", "jpeg",
    "--jpeg-quality", "90",
    "--log=warn",
  ];
  const timeoutMs = Number(process.env.REMOTION_THUMB_TIMEOUT_MS ?? 10 * 60 * 1000);
  console.log(`  [remotion-still] rendering thumbnail → ${out} (timeout ${Math.round(timeoutMs / 60000)}min)`);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("npx", args, { cwd: composerDir, stdio: "inherit" });
      const killer = setTimeout(() => { p.kill("SIGTERM"); setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* dead */ } }, 10_000); }, timeoutMs);
      p.on("error", (e) => { clearTimeout(killer); reject(e); });
      p.on("close", (code) => { clearTimeout(killer); code === 0 ? resolve() : reject(new Error(`remotion still exited ${code}`)); });
    });
    const bytes = await fs.stat(out).then((s) => s.size, () => 0);
    if (bytes < 10_000) throw new Error(`thumbnail is only ${bytes} bytes — truncated`);
    return out;
  } catch (e) {
    console.warn(`  [remotion-still] thumbnail render failed: ${(e as Error).message.slice(0, 200)}`);
    return null;
  }
}

export async function makeThumbnail(
  cfg: ChannelConfig, query: string, text: string, dir: string, used: Set<string>, fallbackImage: string,
  /** the finished video — the thumbnail is cut from its own best moment when given */
  videoPath?: string,
): Promise<string> {
  // The thumbnail should promise what the video actually shows, so take it from the video itself.
  let src = videoPath ? await bestFrameFrom(videoPath, dir).catch(() => null) : null;
  if (src) console.log("  thumbnail: using the video's own best frame");

  if (!src) {
    const raw = path.join(dir, "thumb-raw.jpg");
    const finders = cfg.imageSources.map((n) =>
      n === "pexels" ? pexelsImage : n === "pixabay" ? pixabayImage : n === "openverse" ? openverseImage : commonsImage);
    let got = null;
    for (const find of finders) {
      got = await find(query, used, raw).catch(() => null);
      if (got && got.score >= 0.4) break;
    }
    src = got ? raw : fallbackImage;
  }
  const out = path.join(dir, "thumbnail.jpg");

  // When Phase 3's renderer is on, use the same engine for the thumbnail — same type system,
  // same materials, so the thumbnail doesn't look like it was glued on by a different tool
  // than the video. Falls back to the ffmpeg path below on any failure, so a composer bug
  // doesn't lose the video.
  if (process.env.USE_REMOTION_RENDERER === "true" && !isVideoFile(src)) {
    const t = await makeThumbnailRemotion(src, text, out);
    if (t) return t;
    console.warn("  [thumbnail] Remotion still failed, falling back to ffmpeg drawtext path");
  }
  const single = isVideoFile(src) ? ["-frames:v", "1", "-update", "1"] : [];

  // Punchy grade: tight crop, lifted contrast, saturated, darkened corners so text pops.
  const base = "scale=1600:900:force_original_aspect_ratio=increase,crop=1440:810,scale=1280:720," +
    "eq=contrast=1.3:saturation=1.45:brightness=0.03,unsharp=5:5:1.0,vignette=PI/4";

  const font = await firstFont();
  if (!(await hasDrawtext()) || !font) {
    await sh("ffmpeg", ["-y", "-i", src, "-vf", base, ...single, "-q:v", "2", out]);
    return out;
  }

  // Split into a setup line and a payoff line; the payoff gets the accent colour.
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const split = words.length >= 4 ? Math.ceil(words.length / 2) : words.length > 1 ? words.length - 1 : 1;
  const line1 = words.slice(0, split).join(" ");
  const line2 = words.slice(split).join(" ");
  const f1 = path.join(dir, "t1.txt");
  const f2 = path.join(dir, "t2.txt");
  await fs.writeFile(f1, line1);
  await fs.writeFile(f2, line2);

  const longest = Math.max(line1.length, line2.length || 1);
  const USABLE = 1280 - 52 - 44;                    // left margin + right safety
  const EM = 0.72;                                  // measured width of a bold cap in DejaVu/Arial Bold
  const fs1 = Math.max(52, Math.min(124, Math.floor(USABLE / (longest * EM))));
  const y1 = line2 ? 720 - Math.round(fs1 * 2.35) : 720 - Math.round(fs1 * 1.5);

  const filters = [
    base,
    // a dark wedge behind the text so it reads over any footage
    `drawbox=x=0:y=${y1 - 26}:w=1280:h=${line2 ? fs1 * 2 + 70 : fs1 + 60}:color=black@0.38:t=fill`,
    `drawtext=fontfile='${font}':textfile='${f1}':fontsize=${fs1}:fontcolor=white:borderw=7:bordercolor=black:x=52:y=${y1}`,
  ];
  if (line2) {
    filters.push(`drawtext=fontfile='${font}':textfile='${f2}':fontsize=${fs1}:fontcolor=${ACCENT}:borderw=7:bordercolor=black:x=52:y=${y1 + Math.round(fs1 * 1.12)}`);
  }

  await sh("ffmpeg", ["-y", "-i", src, "-vf", filters.join(","), ...single, "-q:v", "2", out]);
  await fs.rm(f1, { force: true });
  await fs.rm(f2, { force: true });
  return out;
}
