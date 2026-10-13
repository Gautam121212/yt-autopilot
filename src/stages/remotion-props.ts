/**
 * Phase 2: adapter from yt-autopilot's Script + SceneAudio + per-scene assets → OpenMontage's
 * ExplainerProps JSON. Produces JSON only; renderers (shelling out to `npx remotion render`) belong
 * to Phase 3.
 *
 * The seam is deliberately pure data in / pure data out. No file I/O, no side effects — the caller
 * decides whether to write the result to disk, pass it on stdin, or render in-process.
 *
 * Design notes
 *
 * - Asset paths pass through verbatim as absolute paths. OpenMontage's resolveAsset
 *   (remotion-composer/src/lib/resolveAsset.ts) converts absolute POSIX paths to `file://` URIs so
 *   Chromium can load them. Symlinking into public/ is unnecessary.
 * - Cuts carry no `type` field for ordinary image/video sources — Remotion renders them via
 *   Img/OffthreadVideo. `type` is only for the component-based scenes (text_card, stat_card, charts
 *   etc.) which we're not using for a documentary pipeline.
 * - cardHeadline/cardSub become a `stat_reveal` overlay over the first 2.5s of the scene, not a
 *   dedicated Cut — so the B-roll underneath keeps playing while the stat appears.
 * - Captions are emitted at WORD level (OpenMontage's CaptionOverlay expects WordCaption[]). Where
 *   voice.ts gave us sentence-level `segments`, we distribute each sentence's duration evenly across
 *   its words. Not ideal — words don't actually speak for equal durations — but the alternative is
 *   adding a WhisperX forced-alignment stage, deferred to a later phase.
 */
import type { Script, SceneTiming } from "../types";
import type { SceneAudio } from "./voice";

export type Cut = {
  id: string;
  source: string;
  in_seconds: number;
  out_seconds: number;
  animation?: "ken-burns" | "zoom-in" | "zoom-out" | "pan";
  source_in_seconds?: number;
  transition_in?: string;
  transition_out?: string;
};

export type Overlay = {
  type: "section_title" | "stat_reveal" | "hero_title" | "provider_chip";
  in_seconds: number;
  out_seconds: number;
  text?: string;
  subtitle?: string;
};

export type WordCaption = {
  word: string;
  startMs: number;
  endMs: number;
  pageBreakAfter?: boolean;
};

export type ExplainerProps = {
  theme: string;
  cuts: Cut[];
  overlays?: Overlay[];
  captions?: WordCaption[];
  audio?: {
    narration?: { src: string; volume?: number };
    music?: { src: string; volume?: number; fadeInSeconds?: number; fadeOutSeconds?: number; offsetSeconds?: number; loop?: boolean };
  };
};

/** Default shot length targets, mirroring render.ts's SHOT_SECS_H/V. */
const DEFAULT_SHOT_SEC_H = 7;

/**
 * Subdivide a scene's audio into shots of roughly `target` seconds each, cutting on sentence
 * boundaries when available. Mirrors render.ts:planShots so Phase 3 can swap the renderer without
 * the shot count changing per scene.
 */
export function planShots(audio: SceneAudio, target: number): { start: number; dur: number }[] {
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
    const here = sg.end - start;
    const next = segs[i + 1] ? segs[i + 1]!.end - start : Infinity;
    if (last || Math.abs(here - target) <= Math.abs(next - target)) {
      shots.push({ start, dur: (last ? audio.duration : sg.end) - start });
      start = sg.end;
    }
  }
  return shots.filter((sh) => sh.dur > 0.4);
}

const isVideoFile = (f: string) => /\.(mp4|mov|webm)$/i.test(f);

/**
 * Even-distribute a sentence's words across its [start, end] range. Each word gets a slice of equal
 * duration. Real speech varies, but this is "good enough" caption timing until we add forced alignment.
 */
function wordsFromSentence(text: string, startMs: number, endMs: number, pageBreakAfter: boolean): WordCaption[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const total = Math.max(1, endMs - startMs);
  const per = total / words.length;
  return words.map((w, i) => ({
    word: w,
    startMs: Math.round(startMs + i * per),
    endMs: Math.round(startMs + (i + 1) * per),
    ...(pageBreakAfter && i === words.length - 1 ? { pageBreakAfter: true } : {}),
  }));
}

export type BuildOpts = {
  script: Script;
  audios: SceneAudio[];
  /** Scene start/end absolute timings (same shape render.ts emits). */
  timings: SceneTiming[];
  /** For each scene index, a list of absolute asset paths (image or video). First shot of a scene
   *  uses index 0, second shot index 1, etc. If fewer assets than shots, the last asset repeats. */
  sceneAssets: string[][];
  /** Absolute path to the concatenated narration audio (one file for the whole video). */
  narrationFile: string;
  /** Optional absolute path to a music bed. */
  musicFile?: string;
  /** Shot length target in seconds. */
  shotTargetSec?: number;
  /** OpenMontage theme name — one of the themes defined in remotion-composer/src/Root.tsx. */
  theme?: string;
  /** Narration volume (0–1). */
  narrationVolume?: number;
  /** Music bed volume (0–1). Defaults to 0.1 to match render.ts's MUSIC_GAIN. */
  musicVolume?: number;
};

export function buildExplainerProps(o: BuildOpts): ExplainerProps {
  const theme = o.theme ?? "clean-professional";
  const shotTarget = o.shotTargetSec ?? DEFAULT_SHOT_SEC_H;

  const cuts: Cut[] = [];
  const overlays: Overlay[] = [];
  const captions: WordCaption[] = [];

  for (let i = 0; i < o.script.scenes.length; i++) {
    const scene = o.script.scenes[i]!;
    const audio = o.audios[i];
    const timing = o.timings[i];
    const assets = o.sceneAssets[i] ?? [];
    if (!audio || !timing || !assets.length) {
      // A scene with no audio, no timing or no asset can't be rendered. Skip rather than crash;
      // Phase 3 will decide whether to abort the render or produce a partial.
      continue;
    }

    const shots = planShots(audio, shotTarget);
    shots.forEach((shot, k) => {
      const src = assets[Math.min(k, assets.length - 1)]!;
      cuts.push({
        id: `${scene.id}-${k}`,
        source: src,
        in_seconds: +(timing.start + shot.start).toFixed(3),
        out_seconds: +(timing.start + shot.start + shot.dur).toFixed(3),
        // Still images get a subtle Ken Burns; videos play through without zoom.
        ...(isVideoFile(src) ? {} : { animation: "ken-burns" as const }),
        // Fade only at the scene boundary (first in, last out) so mid-scene cuts hard-cut.
        ...(k === 0 ? { transition_in: "fade" } : {}),
        ...(k === shots.length - 1 ? { transition_out: "fade" } : {}),
      });
    });

    // cardHeadline becomes a stat_reveal overlay that lands over the first ~2.5s of the scene.
    const headline = scene.cardHeadline?.trim();
    if (headline) {
      const overlayEnd = Math.min(timing.start + 2.5, timing.end);
      overlays.push({
        type: "stat_reveal",
        in_seconds: +timing.start.toFixed(3),
        out_seconds: +overlayEnd.toFixed(3),
        text: headline,
        ...(scene.cardSub?.trim() ? { subtitle: scene.cardSub.trim() } : {}),
      });
    }

    // Word-level captions. If the voice engine reported sentence `segments`, use them; otherwise
    // treat the whole narration as one span across the scene.
    const segs = audio.segments?.length
      ? audio.segments.map((s) => ({ text: s.text, startSec: timing.start + s.start, endSec: timing.start + s.end }))
      : [{ text: scene.narration, startSec: timing.start, endSec: timing.start + timing.speechSec }];
    segs.forEach((s, k) => {
      captions.push(...wordsFromSentence(s.text, Math.round(s.startSec * 1000), Math.round(s.endSec * 1000), k === segs.length - 1));
    });
  }

  const props: ExplainerProps = {
    theme,
    cuts,
    ...(overlays.length ? { overlays } : {}),
    ...(captions.length ? { captions } : {}),
    audio: {
      narration: { src: o.narrationFile, volume: o.narrationVolume ?? 1 },
      ...(o.musicFile ? { music: { src: o.musicFile, volume: o.musicVolume ?? 0.1, fadeInSeconds: 1.5, fadeOutSeconds: 2, loop: true } } : {}),
    },
  };
  return props;
}
