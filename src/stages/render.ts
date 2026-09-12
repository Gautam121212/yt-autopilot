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
const MOTIONS = [
  (d: number) => `z='min(1+0.28*on/${d},1.28)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,          // push in
  (d: number) => `z='1.28-0.28*on/${d}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,                  // pull out
  (d: number) => `z='1.22':x='(iw-iw/zoom)*on/${d}':y='ih/2-(ih/zoom/2)'`,                           // pan right
  (d: number) => `z='1.22':x='(iw-iw/zoom)*(1-on/${d})':y='ih/2-(ih/zoom/2)'`,                       // pan left
  (d: number) => `z='min(1.05+0.2*on/${d},1.25)':x='(iw-iw/zoom)*on/${d}':y='(ih-ih/zoom)*on/${d}'`, // drift down-right while pushing in
  (d: number) => `z='min(1.05+0.2*on/${d},1.25)':x='(iw-iw/zoom)*(1-on/${d})':y='(ih-ih/zoom)*on/${d}'`, // drift down-left
  (d: number) => `z='1.25':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${d})'`,                       // tilt up
];

type Size = { w: number; h: number };
export const LANDSCAPE: Size = { w: 1920, h: 1080 };
export const VERTICAL: Size = { w: 1080, h: 1920 };

const isVideo = (f: string) => /\.(mp4|mov|webm)$/i.test(f);

async function sceneClip(img: string, audio: SceneAudio, motion: number, out: string, size: Size) {
  // 1.25x (not 1.5x) is enough headroom for a 1.28 zoom and costs far less to scale.
  const bw = Math.round(size.w * 1.25), bh = Math.round(size.h * 1.25);
  const dur = audio.duration + PAD;
  const frames = Math.ceil(dur * FPS);

  if (isVideo(img)) {
    // Stock clip: loop it to the narration length, drop its own audio, keep our voice track.
    await sh("ffmpeg", [
      "-y", "-stream_loop", "-1", "-i", img, "-i", audio.file,
      "-filter_complex",
      `[0:v]scale=${Math.round(size.w * 1.15)}:${Math.round(size.h * 1.15)}:force_original_aspect_ratio=increase,` +
        `crop=${size.w}:${size.h}:'(in_w-out_w)/2+(in_w-out_w)/2*sin(t/6)':'(in_h-out_h)/2',fps=${FPS},format=yuv420p[v];` +
        `[1:a]apad=pad_dur=${PAD},aresample=48000[a]`,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3),
      "-c:v", "libx264", "-preset", "superfast", "-crf", "18", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-ac", "2", out,
    ]);
    return;
  }

  await sh("ffmpeg", [
    "-y", "-i", img, "-i", audio.file,
    "-filter_complex",
    `[0:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `zoompan=${MOTIONS[motion]!(frames)}:d=${frames}:s=${size.w}x${size.h}:fps=${FPS},format=yuv420p[v];` +
      `[1:a]apad=pad_dur=${PAD},aresample=48000[a]`,
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
function buildSrt(scenes: Narrated[], timings: SceneTiming[], audio: SceneAudio[]): string {
  const cues: string[] = [];
  let n = 1;
  const emit = (words: string[], start: number, end: number) => {
    const per = (end - start) / Math.max(words.length, 1);
    for (let j = 0; j < words.length; j += 9) {
      const chunk = words.slice(j, j + 9);
      const a = start + j * per;
      cues.push(`${n++}\n${srtTime(a)} --> ${srtTime(a + chunk.length * per)}\n${chunk.join(" ")}\n`);
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

export async function renderVideo(o: { scenes: Narrated[]; images: string[]; audio: SceneAudio[]; dir: string; seed: number; size?: Size; name?: string; burnCaptions?: boolean }) {
  const size = o.size ?? LANDSCAPE;
  const name = o.name ?? "final";
  const clipsDir = path.join(o.dir, `clips-${name}`);
  await fs.mkdir(clipsDir, { recursive: true });

  // Encode scene clips in parallel (zoompan is single-threaded per clip).
  // Encoding is not perfectly parallel inside one ffmpeg, so run one job per core (min 2).
  const parallel = process.env.LOW_POWER === "true" ? 1 : Math.max(2, Math.min(4, os.cpus().length));
  const clips = await mapLimit(o.scenes, parallel, async (_s, i) => {
    const out = path.join(clipsDir, `${String(i).padStart(3, "0")}.mp4`);
    await sceneClip(o.images[i]!, o.audio[i]!, (i + o.seed) % MOTIONS.length, out, size);
    return out;
  });

  const XFADE = clips.length > 1 && clips.length <= 40 ? 0.4 : 0;
  const timings: SceneTiming[] = [];
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = await durationSec(clips[i]!);
    timings.push({ sceneId: o.scenes[i]!.id, start: t, end: t + d, speechSec: o.audio[i]!.duration });
    t += d - (i < clips.length - 1 ? XFADE : 0);
  }

  const joined = path.join(o.dir, `joined-${name}.mp4`);
  const XF = 0.4; // crossfade length in seconds
  const TRANSITIONS = ["fade", "fadeblack", "smoothleft", "smoothright", "smoothup", "circleopen", "dissolve"];
  if (clips.length > 1 && clips.length <= 40) {
    // xfade chain: each clip dissolves into the next, so scenes flow instead of snapping.
    const inputs = clips.flatMap((c) => ["-i", c]);
    const durs = await Promise.all(clips.map(durationSec));
    let vPrev = "0:v";
    let aPrev = "0:a";
    let offset = durs[0]!;
    const filters: string[] = [];
    for (let i = 1; i < clips.length; i++) {
      const v = `v${i}`;
      const a = `a${i}`;
      // A chapter start gets a firmer transition; everything else dissolves.
      const t = TRANSITIONS[(i + o.seed) % TRANSITIONS.length]!;
      filters.push(`[${vPrev}][${i}:v]xfade=transition=${t}:duration=${XF}:offset=${(offset - XF).toFixed(3)}[${v}]`);
      filters.push(`[${aPrev}][${i}:a]acrossfade=d=${XF}[${a}]`);
      vPrev = v;
      aPrev = a;
      offset += durs[i]! - XF;
    }
    await sh("ffmpeg", ["-y", ...inputs, "-filter_complex", filters.join(";"),
      "-map", `[${vPrev}]`, "-map", `[${aPrev}]`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", joined]);
  } else {
    const list = path.join(o.dir, `clips-${name}.txt`);
    await fs.writeFile(list, clips.map((c) => `file '${c}'`).join("\n"));
    await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  }

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
  await fs.writeFile(srt, buildSrt(o.scenes, timings, o.audio));

  if (o.burnCaptions) {
    const burned = path.join(o.dir, `${name}-cc.mp4`);
    const style = "FontName=DejaVu Sans,Fontsize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Shadow=0,Alignment=2,MarginV=90";
    const ok = await sh("ffmpeg", ["-y", "-i", final, "-vf", `subtitles=${srt}:force_style='${style}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", burned])
      .then(() => true, (e) => { console.warn(`captions not burned in (${String(e).slice(0, 120)})`); return false; });
    if (ok) return { videoPath: burned, srtPath: srt, timings };
  }
  return { videoPath: final, srtPath: srt, timings };
}
