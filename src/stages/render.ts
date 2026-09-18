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
/** Mixed archives look mismatched; one grade pulls Commons, Pexels, NASA and Openverse together. */
const GRADE = "eq=contrast=1.06:saturation=0.92:gamma=0.98,unsharp=5:5:0.4";

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
  // appears a beat after the cut, leaves before the scene ends
  const on = `between(t,0.6,${Math.max(1.2, dur - 1.2).toFixed(2)})`;
  return `drawbox=x=${x - 18}:y=${y - 14}:w=${Math.round(safe.length * fs * 0.62) + 36}:h=${fs + 28}:color=black@0.42:t=fill:enable='${on}',` +
    `drawtext=fontfile='${font}':text='${safe}':fontsize=${fs}:fontcolor=white:` +
    `borderw=2:bordercolor=black@0.7:x=${x}:y=${y}:enable='${on}'`;
}

async function sceneClip(img: string, audio: SceneAudio, motion: number, out: string, size: Size, caption?: string) {
  // Source is scaled well above the output so zoompan's whole-pixel steps fall below one output
  // pixel — this is what removes the shake. Affordable now that scripts are 14-18 scenes, not 28.
  const bw = Math.round(size.w * 1.8), bh = Math.round(size.h * 1.8);
  const dur = audio.duration + PAD;
  const frames = Math.ceil(dur * FPS);

  if (isCard(img)) {
    // Fit the whole card, never crop it, and drift gently instead of zooming.
    await sh("ffmpeg", [
      "-y", "-loop", "1", "-i", img, "-i", audio.file,
      "-filter_complex",
      `[0:v]scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease,` +
        `pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},` +
        `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(dur - FADE).toFixed(2)}:d=${FADE},format=yuv420p[v];` +
        `[1:a]apad=pad_dur=${PAD},aresample=48000,afade=t=in:st=0:d=0.12,afade=t=out:st=${(dur - 0.2).toFixed(2)}:d=0.2[a]`,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3),
      "-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-ac", "2", out,
    ]);
    return;
  }

  const font = await firstFont();
  const cap = caption && font ? `,${captionFilter(caption, size, font, dur)}` : "";

  if (isVideo(img)) {
    // Stock clip: loop it to the narration length, drop its own audio, keep our voice track.
    // -stream_loop on an unreadable file spins forever, so bound the loop count explicitly.
    const clipLen = await durationSec(img).catch(() => 0);
    if (clipLen < 1) throw new Error(`stock clip ${img} is unreadable (${clipLen}s)`);
    const loops = Math.max(0, Math.ceil(dur / clipLen));
    await sh("ffmpeg", [
      "-y", "-stream_loop", String(loops), "-i", img, "-i", audio.file,
      "-filter_complex",
      `[0:v]scale=${Math.round(size.w * 1.15)}:${Math.round(size.h * 1.15)}:force_original_aspect_ratio=increase,` +
        `crop=${size.w}:${size.h}:'(in_w-out_w)/2+(in_w-out_w)/2*sin(t/6)':'(in_h-out_h)/2',fps=${FPS},${GRADE},vignette=PI/5${cap},` +
        `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(dur - FADE).toFixed(2)}:d=${FADE},format=yuv420p[v];` +
        `[1:a]apad=pad_dur=${PAD},aresample=48000,afade=t=in:st=0:d=0.12,afade=t=out:st=${(dur - 0.2).toFixed(2)}:d=0.2[a]`,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3),
      "-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-ac", "2", out,
    ]);
    return;
  }

  const move = MOVES[motion % MOVES.length]!(bw, bh, Number(dur.toFixed(3)));
  await sh("ffmpeg", [
    "-y", "-loop", "1", "-framerate", String(FPS), "-i", img, "-i", audio.file,
    "-filter_complex",
    `[0:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},${move},` +
      `scale=${size.w}:${size.h}:flags=bicubic,${GRADE},vignette=PI/5${cap},` +
      `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(dur - FADE).toFixed(2)}:d=${FADE},format=yuv420p[v];` +
      `[1:a]apad=pad_dur=${PAD},aresample=48000,afade=t=in:st=0:d=0.12,afade=t=out:st=${(dur - 0.2).toFixed(2)}:d=0.2[a]`,
    "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3),
    "-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ac", "2", out,
  ]);
}

function srtTime(sec: number) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Captions: exact sentence timing when the voice engine reports it, else proportional to word count. */
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
      cues.push(`${n++}\n${srtTime(a)} --> ${srtTime(a + chunk.length * per)}\n${chunk.join(" ")}\n`);
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

async function pickMusic(): Promise<string | undefined> {
  const dir = path.join(ROOT, "assets/music");
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => /\.(mp3|m4a|wav)$/i.test(f));
  return files.length ? path.join(dir, files[Math.floor(Math.random() * files.length)]!) : undefined;
}

export async function renderVideo(o: {
  scenes: Narrated[]; images: string[]; audio: SceneAudio[]; dir: string; seed: number;
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

  // Encode scene clips in parallel (zoompan is single-threaded per clip).
  // Encoding is not perfectly parallel inside one ffmpeg, so run one job per core (min 2).
  const parallel = process.env.LOW_POWER === "true" ? 1 : Math.max(2, Math.min(4, os.cpus().length));
  let reused = 0;
  const clips = await mapLimit(o.scenes, parallel, async (_s, i) => {
    const out = path.join(clipsDir, `${String(i).padStart(3, "0")}.mp4`);
    const [clipT, imgT, audT] = await Promise.all([mtime(out), mtime(o.images[i]!), mtime(o.audio[i]!.file)]);
    if (clipT !== Infinity && clipT > imgT && clipT > audT) { reused++; return out; }
    await sceneClip(o.images[i]!, o.audio[i]!, (i + o.seed) % MOVES.length, out, size, o.captions?.[i]);
    return out;
  });
  if (reused) console.log(`  reused ${reused}/${o.scenes.length} unchanged scene clips`);

  const timings: SceneTiming[] = [];
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = await durationSec(clips[i]!);
    timings.push({ sceneId: o.scenes[i]!.id, start: t, end: t + d, speechSec: o.audio[i]!.duration });
    t += d;
  }

  const joined = path.join(o.dir, `joined-${name}.mp4`);
  const list = path.join(o.dir, `clips-${name}.txt`);
  await fs.writeFile(list, clips.map((c) => `file '${c}'`).join("\n"));
  // Stream copy: no re-encode, so joining 28 clips takes seconds instead of ~17 minutes.
  await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);

  const final = path.join(o.dir, `${name}.mp4`);
  const music = await pickMusic();
  const loud = "loudnorm=I=-14:TP=-1.5:LRA=11";
  await sh("ffmpeg", music
    ? ["-y", "-i", joined, "-stream_loop", "-1", "-i", music, "-filter_complex",
        `[0:a]asplit=2[voice][sc];[1:a]volume=0.25[m];[m][sc]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=350[duck];` +
        `[voice][duck]amix=inputs=2:duration=first:normalize=0,${loud}[a]`,
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", final]
    : ["-y", "-i", joined, "-af", loud, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", final]);

  const srt = path.join(o.dir, `${name}.srt`);
  await fs.writeFile(srt, buildSrt(o.scenes, timings, o.audio, size.w < size.h));

  if (o.burnCaptions) {
    const burned = path.join(o.dir, `${name}-cc.mp4`);
    // ASS coordinates, not pixels: MarginV is measured in a 288-tall script space, so 240 put the
    // captions at the TOP of the frame in production. 34 sits them just above YouTube's UI.
    const style = "FontName=DejaVu Sans,Fontsize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
      "Outline=4,Shadow=1,Alignment=2,MarginV=34,MarginL=24,MarginR=24";
    const ok = await sh("ffmpeg", ["-y", "-i", final, "-vf", `subtitles=${srt}:force_style='${style}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", burned])
      .then(() => true, (e) => { console.warn(`captions not burned in (${String(e).slice(0, 120)})`); return false; });
    if (ok) return { videoPath: burned, srtPath: srt, timings };
  }
  return { videoPath: final, srtPath: srt, timings };
}
