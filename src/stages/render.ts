import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../config";
import os from "node:os";
import { durationSec, mapLimit, sh } from "../lib/media";
import type { SceneTiming } from "../types";
import { buildExplainerProps } from "./remotion-props";

type Narrated = { id: string; narration: string };

import type { SceneAudio } from "./voice";

const FPS = 30;
const PAD = 0.4; // breath between scenes

// Motion variety per scene; upscaled input keeps zoompan from jittering.
// Wider zoom range and diagonal drifts read as real camera movement rather than a slideshow.
/**
 * Motion is driven by time through `crop`, not by zoompan.
 *
 * Measured: with a slow pan, ffmpeg's whole-pixel positioning repeats every second frame
 * (150 of 240 frames unique) and the result reads as a shake. At ~2.9px of travel per frame
 * every frame is distinct (240/240). These moves are tuned to sit in that range, and the
 * zoom-only move is deliberately a straight push so there is no sub-pixel drift to stutter.
 */
const MOVES: ((w: number, h: number, dur: number) => string)[] = [
  // pan right across a 1.33x window
  (w, h, d) => `crop=${Math.round(w * 0.75 / 2) * 2}:${Math.round(h * 0.75 / 2) * 2}:x='(in_w-out_w)*(0.02+0.96*t/${d})':y='(in_h-out_h)/2'`,
  // pan left
  (w, h, d) => `crop=${Math.round(w * 0.75 / 2) * 2}:${Math.round(h * 0.75 / 2) * 2}:x='(in_w-out_w)*(0.98-0.96*t/${d})':y='(in_h-out_h)/2'`,
  // tilt down
  (w, h, d) => `crop=${Math.round(w * 0.78 / 2) * 2}:${Math.round(h * 0.78 / 2) * 2}:x='(in_w-out_w)/2':y='(in_h-out_h)*(0.02+0.96*t/${d})'`,
  // tilt up
  (w, h, d) => `crop=${Math.round(w * 0.78 / 2) * 2}:${Math.round(h * 0.78 / 2) * 2}:x='(in_w-out_w)/2':y='(in_h-out_h)*(0.98-0.96*t/${d})'`,
  // diagonal drift
  (w, h, d) => `crop=${Math.round(w * 0.76 / 2) * 2}:${Math.round(h * 0.76 / 2) * 2}:x='(in_w-out_w)*(0.03+0.94*t/${d})':y='(in_h-out_h)*(0.03+0.94*t/${d})'`,
];

type Size = { w: number; h: number };
export const LANDSCAPE: Size = { w: 1920, h: 1080 };
export const VERTICAL: Size = { w: 1080, h: 1920 };

const isVideo = (f: string) => /\.(mp4|mov|webm)$/i.test(f);
/** Cards carry text to the edges of the safe area — zooming into them crops the words off. */
const isCard = (f: string) => /-card\.jpg$/i.test(f);

const FADE = 0.35; // fade in/out baked into each clip so the join can be a stream copy
/** Target seconds per shot. Research on faceless retention: a visual reset every 3-5s (vertical),
 *  6-9s for documentary-style horizontal. Below this and it reads as chaos; above it, as a slideshow. */
const SHOT_SECS_H = Number(process.env.SHOT_SECS_H ?? 7);
const SHOT_SECS_V = Number(process.env.SHOT_SECS_V ?? 3.5);

/** Group a scene's sentences into shots of roughly `target` seconds each. */
function planShots(audio: SceneAudio, target: number): { start: number; dur: number }[] {
  // No sentence timings? Cut on the clock instead. A scene must NEVER become one long held shot.
  if (!audio.segments?.length) {
    const n = Math.max(1, Math.round(audio.duration / target));
    const each = audio.duration / n;
    return Array.from({ length: n }, (_, i) => ({ start: i * each, dur: each }));
  }
  const segs = audio.segments;
  const shots: { start: number; dur: number }[] = [];
  let start = 0;
  for (const [i, sg] of segs.entries()) {
    const last = i === segs.length - 1;
    const here = sg.end - start;                       // length if we cut at the end of this sentence
    const next = segs[i + 1] ? segs[i + 1]!.end - start : Infinity; // ... or at the end of the next one
    // Cut at whichever boundary lands closest to the target, so shots cluster around it
    // instead of always overshooting.
    if (last || Math.abs(here - target) <= Math.abs(next - target)) {
      shots.push({ start, dur: (last ? audio.duration : sg.end) - start });
      start = sg.end;
    }
  }
  return shots.filter((sh) => sh.dur > 0.4);
}
/** Mixed archives look mismatched; one grade pulls Pexels, Pixabay, Commons and Openverse footage together. */
const GRADE = "eq=contrast=1.06:saturation=0.92:gamma=0.98,unsharp=5:5:0.4";

/** Music sits well below the voice; the sidechain ducking does the rest. */
const MUSIC_GAIN = Number(process.env.MUSIC_GAIN ?? 0.10);
/**
 * Bitrate ceiling. Each shot is encoded as its own short clip, and x264 starts every encode with its
 * VBV buffer ~90% full, so a 24 Mbit buffer let each 6-second clip burst ~3.6 Mbps past the cap —
 * a dry run measured 13.6 Mbps against a 12 Mbps ceiling. A one-second buffer bounds that burst.
 * YouTube re-encodes to ~8 Mbps for 1080p30, so a 10 Mbps upload loses nothing visible.
 */
const MAXRATE = process.env.VIDEO_MAXRATE ?? "10M";
const BUFSIZE = process.env.VIDEO_BUFSIZE ?? "10M";

const FONTS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
];
async function firstFont(): Promise<string | null> {
  for (const f of FONTS) if (await fs.access(f).then(() => true, () => false)) return f;
  return null;
}

/** A short caption burned into the corner of a shot — the alternative to a full-screen text slide. */
function captionFilter(text: string, size: Size, font: string, dur: number): string {
  const safe = text.toUpperCase().replace(/[':\\%]/g, "");
  const fs = Math.max(34, Math.min(Math.round(size.w / 18), Math.round((size.w * 0.8) / (safe.length * 0.62))));
  const x = Math.round(size.w * 0.055);
  const y = Math.round(size.h * 0.74);
  // Starts after the fade-in has finished, so the words never appear over black, and leaves
  // before the shot ends so it cannot bleed into the next cut.
  const appear = Math.max(FADE + 0.25, 0.6);
  const leave = Math.max(appear + 0.6, dur - 0.8);
  const on = `between(t,${appear.toFixed(2)},${leave.toFixed(2)})`;
  const boxW = Math.round(safe.length * fs * 0.66) + 34;
  return `drawbox=x=${x - 16}:y=${y - 12}:w=${boxW}:h=${fs + 24}:color=black@0.55:t=fill:enable='${on}',` +
    `drawtext=fontfile='${font}':text='${safe}':fontsize=${fs}:fontcolor=white:` +
    `borderw=2:bordercolor=black@0.7:x=${x}:y=${y}:enable='${on}'`;
}

async function shotClip(
  img: string, audioFile: string, audioStart: number, dur: number,
  motion: number, out: string, size: Size, caption: string | undefined,
  fadeIn: boolean, fadeOut: boolean,
) {
  const frames = Math.ceil(dur * FPS);
  const fIn = fadeIn ? `fade=t=in:st=0:d=${FADE},` : "";
  const fOut = fadeOut ? `fade=t=out:st=${Math.max(0.1, dur - FADE).toFixed(2)}:d=${FADE},` : "";
  const aIn = fadeIn ? "afade=t=in:st=0:d=0.10," : "";
  const aOut = fadeOut ? `afade=t=out:st=${Math.max(0.1, dur - 0.2).toFixed(2)}:d=0.2,` : "";
  const font = await firstFont();
  const cap = caption && font ? `${captionFilter(caption, size, font, dur)},` : "";
  const bw = Math.round(size.w * 1.8), bh = Math.round(size.h * 1.8);

  // audio: the slice of this scene's narration that belongs to this shot
  const audioIn = ["-ss", audioStart.toFixed(3), "-t", dur.toFixed(3), "-i", audioFile];
  const aChain = `[1:a]aresample=48000,apad,atrim=0:${dur.toFixed(3)},${aIn}${aOut}asetpts=N/SR/TB[a]`;
  const encode = [
    "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3),
    // CRF 18 keeps quality; the VBV ceiling stops motion over detailed stills spiking past what
    // YouTube uses (it re-encodes everything; ~8 Mbps is its 1080p30 guide). Without it a dry run
    // produced 21 Mbps — about 1.6 GB for a 10-minute video.
    "-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-maxrate", MAXRATE, "-bufsize", BUFSIZE, "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out,
  ];

  if (isVideo(img)) {
    const clipLen = await durationSec(img).catch(() => 0);
    if (clipLen < 1) throw new Error(`stock clip ${img} is unreadable (${clipLen}s)`);
    const loops = Math.max(0, Math.ceil(dur / clipLen));
    await sh("ffmpeg", [
      "-y", "-stream_loop", String(loops), "-i", img, ...audioIn,
      "-filter_complex",
      `[0:v]scale=${Math.round(size.w * 1.15)}:${Math.round(size.h * 1.15)}:force_original_aspect_ratio=increase,` +
        `crop=${size.w}:${size.h}:'(in_w-out_w)/2+(in_w-out_w)/2*sin(t/6)':'(in_h-out_h)/2',fps=${FPS},${GRADE},vignette=PI/5,` +
        `${cap}${fIn}${fOut}format=yuv420p[v];${aChain}`,
      ...encode,
    ]);
    return;
  }

  const move = MOVES[motion % MOVES.length]!(bw, bh, Number(dur.toFixed(3)));
  await sh("ffmpeg", [
    "-y", "-loop", "1", "-framerate", String(FPS), "-i", img, ...audioIn,
    "-filter_complex",
    `[0:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},${move},` +
      `scale=${size.w}:${size.h}:flags=bicubic,${GRADE},vignette=PI/5,${cap}${fIn}${fOut}format=yuv420p[v];${aChain}`,
    ...encode,
  ]);
}

function srtTime(sec: number) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Captions: exact sentence timing when the voice engine reports it, else proportional to word count. */
/** Never let a caption sit on the opening fade — it reads as text arriving before the video. */
const CAPTION_LEAD_IN = FADE + 0.15;

function buildSrt(scenes: Narrated[], timings: SceneTiming[], audio: SceneAudio[], vertical = false): string {
  const cues: string[] = [];
  let n = 1;
  // Vertical burns captions on screen, so cues must be short enough to read in two lines.
  const perCue = vertical ? 5 : 9;
  const emit = (words: string[], start: number, end: number) => {
    const per = (end - start) / Math.max(words.length, 1);
    // Prefer breaking after a comma or full stop so a cue never ends mid-phrase. Two exceptions:
    //
    // 1) Decimals: "0.1 inches" tokenized across a boundary gave `"0."` + `"1 inches"` on #60.
    //    A word ending `digit + .` whose SUCCESSOR starts with a digit stays intact.
    //
    // 2) Abbreviations: "7:10 p.m." gave `"7:10 p."` + `"m."` on #61 (seen in captions.srt
    //    cues 1-2). Common abbreviations end mid-sentence with a `.` that shouldn't trigger a
    //    cue break. Matched against a small list; if adding one, keep it lowercase and the
    //    comparison strips trailing punct from the word first.
    const ABBREV = new Set(["p.m", "a.m", "e.g", "i.e", "b.c", "a.d", "u.s", "u.k",
      "mr", "mrs", "ms", "dr", "jr", "sr", "st", "vs", "etc", "inc", "ltd", "co", "prof", "fig", "no"]);
    const chunks: string[][] = [];
    let cur: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      cur.push(w);
      const endsPunct = /[,.;:!?]$/.test(w);
      const isDecimalLeft = /\d\.$/.test(w) && /^\d/.test(words[i + 1] ?? "");
      // Strip the trailing punct and any leading punct/dashes so we match the raw abbrev form.
      const bare = w.replace(/[^A-Za-z0-9.]/g, "").replace(/\.$/, "").toLowerCase();
      const isAbbrev = ABBREV.has(bare);
      // Single-letter initial before a capitalized name: "H. Schultes", "J. R. R. Tolkien".
      // Common in historical science writing. Detect: word is "X." (one capital + period) AND the
      // NEXT word starts with a capital letter OR another initial. #63 cue 1→2 split "Hermann
      // Frenzel and H." + "Schultes filled a tank..." on this exact pattern.
      const isInitial = /^[A-Z]\.$/.test(w) && /^[A-Z]/.test(words[i + 1] ?? "");
      const breakable = endsPunct && !isDecimalLeft && !isAbbrev && !isInitial;
      if (cur.length >= perCue || (breakable && cur.length >= Math.max(3, perCue - 2))) { chunks.push(cur); cur = []; }
    }
    if (cur.length) {
      if (cur.length <= 2 && chunks.length) chunks[chunks.length - 1]!.push(...cur); // no orphan cue
      else chunks.push(cur);
    }
    let idx = 0;
    for (const chunk of chunks) {
      const a = start + idx * per;
      const from = Math.max(a, CAPTION_LEAD_IN);
      const to = Math.max(from + 0.4, a + chunk.length * per);
      cues.push(`${n++}\n${srtTime(from)} --> ${srtTime(to)}\n${chunk.join(" ")}\n`);
      idx += chunk.length;
    }
  };
  scenes.forEach((s, i) => {
    const t = timings[i]!;
    const segs = audio[i]?.segments;
    if (segs?.length) for (const g of segs) emit(g.text.split(/\s+/).filter(Boolean), t.start + g.start, t.start + g.end);
    else emit(s.narration.split(/\s+/).filter(Boolean), t.start, t.start + t.speechSec);
  });
  return cues.join("\n");
}

/**
 * Any audio file in assets/music/ becomes a candidate bed; an empty folder means no music and
 * nothing breaks. Chosen by seed rather than at random so a video and its Short can differ
 * deliberately and a re-render is reproducible.
 */
async function pickMusic(seed: number): Promise<string | undefined> {
  if (process.env.MUSIC === "off") return undefined;
  const dir = path.join(ROOT, "assets/music");
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f)).sort();
  return files.length ? path.join(dir, files[seed % files.length]!) : undefined;
}

/**
 * Phase 3 — the Remotion render path, behind USE_REMOTION_RENDERER=true.
 *
 * Keeps the same signature + return shape as renderVideo so callers can't tell the difference.
 * Internally:
 *   1. normalize per-scene asset lists
 *   2. compute scene timings from audio durations
 *   3. concat per-scene narration into one wav for the composer
 *   4. pick a music bed (same seed / same assets/music folder as the ffmpeg path)
 *   5. buildExplainerProps(...) via the Phase 2 adapter
 *   6. write <dir>/remotion-props.json
 *   7. shell `npx remotion render src/index.tsx Explainer <out.mp4> --props <json>` from
 *      remotion-composer/
 *   8. generate the SRT via the existing buildSrt() so captions.srt stays identical to the
 *      ffmpeg path's output (upload stage reads it)
 *   9. return { videoPath, srtPath, timings }
 */
async function renderWithRemotion(o: {
  scenes: Narrated[];
  images: (string | string[])[];
  audio: SceneAudio[]; dir: string; seed: number;
  size?: Size; name?: string;
  captions?: (string | undefined)[];
}): Promise<{ videoPath: string; srtPath: string; timings: SceneTiming[] }> {
  const size = o.size ?? LANDSCAPE;
  const name = o.name ?? "final";
  const shotTarget = size.w < size.h ? SHOT_SECS_V : SHOT_SECS_H;

  // 1. Normalize assets. renderVideo accepts `string | string[]` per scene — Remotion wants an
  //    array per scene (one asset per shot).
  const sceneAssets: string[][] = o.images.map((x) => Array.isArray(x) ? x : [x]).map((xs) => xs.filter(Boolean) as string[]);
  if (sceneAssets.some((a) => a.length === 0)) {
    throw new Error("renderWithRemotion: at least one scene has no assets — the composer can't render an empty scene");
  }

  // 2. Scene timings: cumulative sum of audio durations. The composer uses in_seconds/out_seconds
  //    on each Cut relative to the start of the video, so these have to line up with the narration.
  const timings: SceneTiming[] = [];
  let t = 0;
  for (let i = 0; i < o.scenes.length; i++) {
    const dur = o.audio[i]!.duration;
    timings.push({ sceneId: o.scenes[i]!.id, start: t, end: t + dur, speechSec: dur });
    t += dur;
  }

  // 3. Concat narration. Kokoro emits PCM float32 (pcm_f32le @ 24 kHz), which the MP4/m4a
  //    container does NOT accept — a stream copy here previously failed hard with "Could not
  //    find tag for codec pcm_f32le in stream #0" (run #60, 14 Oct 06:41 UTC: produce.verified
  //    incident at ffmpeg exit 234). Re-encode to AAC-LC so the output is a container-valid
  //    file Remotion can read. Extra 2–5s per video, worth it for correctness.
  const narrationFile = path.join(o.dir, "narration-full.m4a");
  const listFile = path.join(o.dir, "narration-list.txt");
  await fs.writeFile(listFile, o.audio.map((a) => `file '${a.file}'`).join("\n"));
  await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", narrationFile]);

  // 4. Music: same picker as the ffmpeg path so the look-and-feel stays consistent across the flag.
  const music = await pickMusic(o.seed);

  // 5. Props. The adapter wants a Script-shaped object; we only need id, narration and
  //    cardHeadline/cardSub (= the figure captions passed in). Everything else is unused.
  const scriptShim = {
    scenes: o.scenes.map((s, i) => ({
      id: s.id,
      narration: s.narration,
      cardHeadline: o.captions?.[i] ?? "",
      cardSub: "",
    })),
  } as Parameters<typeof buildExplainerProps>[0]["script"];

  const props = buildExplainerProps({
    script: scriptShim,
    audios: o.audio,
    timings,
    sceneAssets,
    narrationFile,
    musicFile: music ?? undefined,
    shotTargetSec: shotTarget,
    // Later we can key the theme to channel.json; for now use the design system that shipped with
    // OpenMontage's zero-key explainer demo (clean, dark, high contrast).
    theme: process.env.REMOTION_THEME ?? "clean-professional",
  });

  // 6a. Stage assets into remotion-composer/public/ so Chromium can load them.
  //
  //     History: Phase 1 scoping assumed resolveAsset.ts's file:// conversion would work in
  //     Chromium (run #61 at 16:06 UTC: "Not allowed to load local resource" for every asset).
  //     PR #31 switched to SYMLINKS from public/run-<id>/ into work/<id>/ to serve via Remotion's
  //     static origin. First run with that fix (#61 at 19:28 UTC) revealed the next layer: the
  //     Remotion bundler copies public/ to its /tmp/remotion-webpack-bundle-*/ dir at build
  //     time, and SYMLINKS DO NOT SURVIVE THAT COPY. The bundle's public/ directory then has
  //     either broken links or missing files, and every asset 404s from Chromium:
  //         Received a status code of 404 while downloading file
  //         http://localhost:3000/public/run-61/tMC5tcDQ-sel-000-0.mp4
  //         (/tmp/remotion-webpack-bundle-chyydO/public/run-61/tMC5tcDQ-sel-000-0.mp4)
  //         could not be found
  //
  //     Fix: COPY the files instead. Costs ~50 MB per video of extra disk, which GH Actions
  //     runners don't care about. Guaranteed to survive the bundler's public/ snapshot.
  //     The stage dir is wiped at the start of each render so re-runs don't accumulate state.
  const composerDirForStaging = path.join(ROOT, "remotion-composer");
  const runId = path.basename(o.dir);
  const stageDir = path.join(composerDirForStaging, "public", `run-${runId}`);
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  const staged = new Map<string, string>();
  const stage = async (abs: string): Promise<string> => {
    if (!abs) return abs;
    const cached = staged.get(abs);
    if (cached) return cached;
    // Collision-safe name: basename alone can repeat across scenes (e.g. multiple scenes using
    // the same pool image). Prefix with a short hash of the full path.
    const hash = Buffer.from(abs).toString("base64url").slice(-8);
    const base = `${hash}-${path.basename(abs)}`;
    const target = path.join(stageDir, base);
    await fs.copyFile(abs, target);
    const rel = `run-${runId}/${base}`;
    staged.set(abs, rel);
    return rel;
  };
  for (const cut of props.cuts) cut.source = await stage(cut.source);
  if (props.audio?.narration?.src) props.audio.narration.src = await stage(props.audio.narration.src);
  if (props.audio?.music?.src) props.audio.music.src = await stage(props.audio.music.src);

  // 6b. Write the props JSON (now with staged relative paths).
  const propsFile = path.join(o.dir, "remotion-props.json");
  await fs.writeFile(propsFile, JSON.stringify(props, null, 2));

  // 7. Shell. Chromium render is CPU-bound; let it use what the runner has. --log=warn so we see
  //    anything that needs attention without drowning in frame-by-frame progress noise.
  //
  //    Per-render timeout matters now that this is the default renderer: a hung Chromium or an
  //    infinite loop in a composer component previously would have sat for the whole 230-min step
  //    budget on ONE video. Default 60 min covers the 10–30 min expected window with slack for a
  //    one-time Chromium download on a cold runner (~5 min) and the long tail. Override with
  //    REMOTION_TIMEOUT_MS when debugging a slow render. On timeout we SIGKILL (SIGTERM first
  //    isn't honored by headless Chrome quickly enough) and reject — render.ts' outer try/catch
  //    then falls back to ffmpeg so the video still ships.
  const timeoutMs = Number(process.env.REMOTION_TIMEOUT_MS ?? 60 * 60 * 1000);
  const final = path.join(o.dir, `${name}.mp4`);
  const composerDir = path.join(ROOT, "remotion-composer");
  const args = [
    "remotion", "render", "src/index.tsx", "Explainer", final,
    "--props", propsFile,
    "--codec", "h264",
    "--concurrency", process.env.REMOTION_CONCURRENCY ?? String(Math.max(1, Math.min(4, os.cpus().length))),
    "--log=warn",
  ];
  console.log(`  [remotion] rendering via npx remotion render → ${final} (timeout ${Math.round(timeoutMs / 60000)}min)`);
  const startedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const p = spawn("npx", args, { cwd: composerDir, stdio: "inherit" });
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      console.warn(`  [remotion] render exceeded ${Math.round(timeoutMs / 60000)}min — killing`);
      p.kill("SIGTERM");
      // SIGTERM may not win against a stuck Chromium quickly; follow up with SIGKILL after 10s.
      setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* already dead */ } }, 10_000);
    }, timeoutMs);
    p.on("error", (e) => { clearTimeout(killer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(killer);
      if (timedOut) reject(new Error(`remotion render timed out after ${Math.round(timeoutMs / 60000)}min`));
      else if (code !== 0) reject(new Error(`remotion render exited ${code}`));
      else resolve();
    });
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`  [remotion] render complete in ${elapsed}s`);
  const bytes = (await fs.stat(final)).size;
  if (bytes < 100_000) throw new Error(`remotion render reported success but ${final} is only ${bytes} bytes — looks truncated`);

  // 8. SRT, same shape and timings as the ffmpeg path, so publish.ts can upload captions without
  //    knowing which renderer produced them.
  const srt = path.join(o.dir, `${name}.srt`);
  await fs.writeFile(srt, buildSrt(o.scenes, timings, o.audio, size.w < size.h));

  return { videoPath: final, srtPath: srt, timings };
}

export async function renderVideo(o: {
  scenes: Narrated[];
  /** one or more images/clips per scene — the render cuts between them on sentence boundaries */
  images: (string | string[])[];
  audio: SceneAudio[]; dir: string; seed: number;
  size?: Size; name?: string; burnCaptions?: boolean;
  /** short figure captions, one per scene, burned over the footage instead of shown as a slide */
  captions?: (string | undefined)[];
}) {
  // Phase 3: Remotion renderer, now default-ON per the workflow. ffmpeg stays as a per-run
  // fallback — if the composer crashes (Chromium OOM, bad asset path, upstream OpenMontage bug),
  // we log it and finish the video with the proven ffmpeg path instead of abandoning the whole
  // run. burnCaptions is ignored on the Remotion path: the composer's own CaptionOverlay handles
  // it, and burning on top of a rendered video would duplicate text.
  if (process.env.USE_REMOTION_RENDERER === "true") {
    try {
      return await renderWithRemotion({ scenes: o.scenes, images: o.images, audio: o.audio, dir: o.dir, seed: o.seed, size: o.size, name: o.name, captions: o.captions });
    } catch (e) {
      // Hard-fail the Remotion path only when the user asked for it explicitly (via env override);
      // otherwise fall through to ffmpeg so the video still ships. Logged either way.
      const msg = (e as Error).message?.slice(0, 400) ?? String(e);
      console.warn(`  [render] Remotion renderer failed, falling back to ffmpeg: ${msg}`);
      if (process.env.REMOTION_STRICT === "true") throw e;
    }
  }
  const size = o.size ?? LANDSCAPE;
  const name = o.name ?? "final";
  // One shared clip cache per video: a repair round only re-encodes the scenes whose
  // image or audio actually changed, instead of rebuilding all 25 clips.
  const clipsDir = path.join(o.dir, `clips-${o.size === VERTICAL ? "v" : "h"}`);
  await fs.mkdir(clipsDir, { recursive: true });
  const mtime = async (f: string) => (await fs.stat(f).then((x) => x.mtimeMs, () => Infinity));

  const parallel = process.env.LOW_POWER === "true" ? 1 : Math.max(2, Math.min(4, os.cpus().length));
  const shotTarget = size.w < size.h ? SHOT_SECS_V : SHOT_SECS_H;

  // Plan every shot first: each scene becomes N shots, cutting where a sentence ends, so the
  // picture changes exactly when the narration moves on.
  type Shot = { sceneIdx: number; img: string; audioFile: string; start: number; dur: number; first: boolean; last: boolean; caption?: string };
  const plan: Shot[] = [];
  for (const [i, a] of o.audio.entries()) {
    const imgs = (Array.isArray(o.images[i]) ? (o.images[i] as string[]) : [o.images[i] as string]).filter(Boolean);
    // Fewer pictures than shots used to cycle the SAME picture through consecutive shots, which reads
    // as a glitch (27 Sep: one truck photo three times in a row). Lengthen the shots instead, so each
    // picture is shown once, up to MAX_HOLD; past that a repeat is the lesser evil than a frozen frame.
    const maxHold = shotTarget * Number(process.env.SHOT_MAX_HOLD_X ?? 2);
    const target = imgs.length ? Math.max(shotTarget, Math.min(maxHold, a.duration / imgs.length)) : shotTarget;
    const shots = planShots(a, target);
    for (const [j, sh_] of shots.entries()) {
      plan.push({
        sceneIdx: i,
        img: imgs[j % imgs.length]!,
        audioFile: a.file,
        start: sh_.start,
        dur: sh_.dur + (j === shots.length - 1 ? PAD : 0),
        first: j === 0,
        last: j === shots.length - 1,
        // the figure caption belongs on the scene's opening shot only
        caption: j === 0 ? o.captions?.[i] : undefined,
      });
    }
  }
  console.log(`  ${plan.length} shots across ${o.scenes.length} scenes (~${(plan.reduce((n, p) => n + p.dur, 0) / plan.length).toFixed(1)}s each)`);

  let reused = 0;
  const clips = await mapLimit(plan, parallel, async (shot, k) => {
    const out = path.join(clipsDir, `${String(k).padStart(3, "0")}.mp4`);
    const [clipT, imgT, audT] = await Promise.all([mtime(out), mtime(shot.img), mtime(shot.audioFile)]);
    if (clipT !== Infinity && clipT > imgT && clipT > audT) { reused++; return out; }
    await shotClip(shot.img, shot.audioFile, shot.start, shot.dur, k + o.seed, out, size, shot.caption, shot.first, shot.last);
    return out;
  });
  if (reused) console.log(`  reused ${reused}/${plan.length} unchanged shots`);

  const lengths = await Promise.all(clips.map((c) => durationSec(c)));
  const timings: SceneTiming[] = [];
  let t = 0;
  for (let i = 0; i < o.scenes.length; i++) {
    const mine = plan.map((p, k) => (p.sceneIdx === i ? lengths[k]! : 0)).reduce((a, b) => a + b, 0);
    timings.push({ sceneId: o.scenes[i]!.id, start: t, end: t + mine, speechSec: o.audio[i]!.duration });
    t += mine;
  }

  const joined = path.join(o.dir, `joined-${name}.mp4`);
  const list = path.join(o.dir, `clips-${name}.txt`);
  await fs.writeFile(list, clips.map((c) => `file '${c}'`).join("\n"));
  // Stream copy: no re-encode, so joining 28 clips takes seconds instead of ~17 minutes.
  await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);

  const final = path.join(o.dir, `${name}.mp4`);
  const music = await pickMusic(o.seed);
  const loud = "loudnorm=I=-14:TP=-1.5:LRA=11";
  await sh("ffmpeg", music
    ? ["-y", "-i", joined, "-stream_loop", "-1", "-i", music, "-filter_complex",
        // 0.25 was loud enough to fight the narration; 0.10 sits under it. Ducking then dips it further
        // whenever the voice is speaking.
        `[0:a]asplit=2[voice][sc];[1:a]volume=${MUSIC_GAIN}[m];[m][sc]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=350[duck];` +
        `[voice][duck]amix=inputs=2:duration=first:normalize=0,${loud}[a]`,
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", final]
    : ["-y", "-i", joined, "-af", loud, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", final]);

  const srt = path.join(o.dir, `${name}.srt`);
  await fs.writeFile(srt, buildSrt(o.scenes, timings, o.audio, size.w < size.h));

  if (o.burnCaptions) {
    const burned = path.join(o.dir, `${name}-cc.mp4`);
    // Shorts safe zone: YouTube overlays the channel name, title and music line on roughly the
    // bottom quarter. 100 in a 288-tall script space (~35% up) sits captions just above the UI.
    //
    // Style tuned to approximate OpenMontage's CaptionOverlay look as closely as ASS allows,
    // so Shorts that fall back to the ffmpeg path (Phase 3 crashed, we burn here) don't look
    // like old-school 2010-era subtitle blocks. Specifically:
    // - Fontsize 24 (was 15): big enough to read on a phone without feeling like 90s karaoke.
    // - BackColour + BorderStyle=4: translucent dark pill behind the text (~47% black opacity)
    //   mirrors the backdrop-blurred caption pill from the Remotion CaptionOverlay. ASS can't
    //   do real backdrop-blur, but a semi-opaque backing box is the closest fallback.
    // - Outline 1, Shadow 1: crisp, not thick. The old Outline=4 produced the "heavy block"
    //   look the user flagged on #61 fallback renders.
    // - Spacing=-1: slight negative tracking at display size, matching the Apple-design rule
    //   my CaptionOverlay patch (PR #20) also applies at this font size range.
    const style = "FontName=DejaVu Sans,Fontsize=24,Bold=1," +
      "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H88000000," +
      "BorderStyle=4,Outline=1,Shadow=1,Alignment=2,MarginV=100,MarginL=48,MarginR=48,Spacing=-1";
    const ok = await sh("ffmpeg", ["-y", "-i", final, "-vf", `subtitles=${srt}:force_style='${style}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", MAXRATE, "-bufsize", BUFSIZE,
      "-c:a", "copy", "-movflags", "+faststart", burned])
      .then(() => true, (e) => { console.warn(`captions not burned in (${String(e).slice(0, 120)})`); return false; });
    if (ok) return { videoPath: burned, srtPath: srt, timings };
  }
  return { videoPath: final, srtPath: srt, timings };
}
