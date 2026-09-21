import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../config";
import os from "node:os";
import { durationSec, mapLimit, sh } from "../lib/media";
import type { SceneTiming } from "../types";

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
    // Prefer breaking after a comma or full stop so a cue never ends mid-phrase.
    const chunks: string[][] = [];
    let cur: string[] = [];
    for (const w of words) {
      cur.push(w);
      const breakable = /[,.;:!?]$/.test(w);
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

export async function renderVideo(o: {
  scenes: Narrated[];
  /** one or more images/clips per scene — the render cuts between them on sentence boundaries */
  images: (string | string[])[];
  audio: SceneAudio[]; dir: string; seed: number;
  size?: Size; name?: string; burnCaptions?: boolean;
  /** short figure captions, one per scene, burned over the footage instead of shown as a slide */
  captions?: (string | undefined)[];
}) {
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
    const shots = planShots(a, shotTarget);
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
    // Shorts safe zone: YouTube overlays the channel name, title and music line on roughly the bottom
    // quarter, so MarginV=34 (~12% up) put the second caption line under the UI on a phone. 80 of 288
    // (~28% up) sits the captions just above it — the same band the big Shorts channels use.
    // ASS coordinates, not pixels: MarginV is measured in a 288-tall script space, so 240 put the
    // captions at the TOP of the frame in production.
    const style = "FontName=DejaVu Sans,Fontsize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
      "Outline=4,Shadow=1,Alignment=2,MarginV=80,MarginL=24,MarginR=24";
    const ok = await sh("ffmpeg", ["-y", "-i", final, "-vf", `subtitles=${srt}:force_style='${style}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", MAXRATE, "-bufsize", BUFSIZE,
      "-c:a", "copy", "-movflags", "+faststart", burned])
      .then(() => true, (e) => { console.warn(`captions not burned in (${String(e).slice(0, 120)})`); return false; });
    if (ok) return { videoPath: burned, srtPath: srt, timings };
  }
  return { videoPath: final, srtPath: srt, timings };
}
