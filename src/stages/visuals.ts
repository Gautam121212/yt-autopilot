import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelConfig } from "../config";
import { incident } from "../lib/log";
import { mapLimit, sh } from "../lib/media";
import { log } from "../lib/log";
import {
  commonsImage, HISTORICAL_HINT, openverseImage, pexelsImage, pexelsVideo,
  pixabayImage, pixabayVideo, generatedClip, type ImageHit,
} from "../lib/sources";

export type ImageCredit = { source: string; id: string; title: string; attribution?: string };

const MIN_USABLE = 0.25;
/** Verified on disk, not trusted from the API: a stretched 900px jpg is what "looks cheap" means. */
async function bigEnough(file: string, minW: number): Promise<boolean> {
  const out = await sh("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).catch(() => "");
  const [w, h] = out.trim().split(",").map(Number);
  return (w ?? 0) >= minW && (h ?? 0) >= Math.round(minW * 0.5);
}
// Per scene: enough for several sources, not enough to stall a run. The pool covers the misses.
const SCENE_BUDGET_MS = Number(process.env.SCENE_BUDGET_MS ?? 90_000);
/** Whole-phase ceiling. Past this, remaining scenes take pooled footage immediately. */
const PHASE_BUDGET_MS = Number(process.env.PHASE_BUDGET_MS ?? 20 * 60_000);

function withBudget<T>(p: Promise<T>, ms: number, fallback: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), ms); });
  return Promise.race([p, timeout]).then((r) => (r === "timeout" ? fallback() : (r as T))).finally(() => clearTimeout(timer));
}

const FINDERS: Record<string, (q: string, used: Set<string>, file: string) => Promise<ImageHit | null>> = {
  pexels: pexelsImage,
  pixabay: pixabayImage,
  commons: commonsImage,
  openverse: openverseImage,
};

/** Every video source, tried in order, for scenes the writer marked as motion.
 *  Generated clips come LAST and only when AI_CLIPS=true: they are slow and rate-limited, so they
 *  fill what stock cannot rather than carrying the video. */
const CLIP_FINDERS = [pexelsVideo, pixabayVideo];

/** Fetch a different image for one scene, avoiding everything already used in this video. */
export async function replaceSceneImage(
  cfg: ChannelConfig, scene: { id: string; imageQuery: string; altQueries?: string[]; era?: string }, file: string, used: Set<string>, videoId: number, fallbacks?: string[],
): Promise<ImageCredit | null> {
  // Same rule as above: order by era, never drop a source.
  const names = cfg.imageSources.filter((n) => FINDERS[n]);
  const ordered = scene.era === "historical"
    ? [...names.filter((n) => n === "commons" || n === "openverse"), ...names.filter((n) => n !== "commons" && n !== "openverse")]
    : names;
  const sources = ordered.map((n) => FINDERS[n]!);
  const parts = scene.imageQuery.split(/\s+/).filter(Boolean);
  for (const q of [...(scene.altQueries ?? []), scene.imageQuery, parts.slice(0, 2).join(" "), ...(fallbacks ?? cfg.fallbackImageQueries)]) {
    for (const find of sources) {
      const got = await find(q, used, file).catch(() => null);
      if (got) return { source: got.source, id: got.id, title: got.title, attribution: got.attribution };
    }
  }
  await incident("visuals.no-replacement", new Error(`nothing left for scene ${scene.id}`), videoId);
  return null;
}

/**
 * One freely reusable photo per scene, never repeated inside a video.
 * Tries each configured source with progressively broader queries, keeps the best-scoring hit,
 * and only uses a generic fallback query when nothing relevant exists anywhere.
 */
/** On-topic fallbacks beat generic ones: another photo of the subject is always better than a stock clock. */
export function topicFallbacks(subject: string, cfg: ChannelConfig): string[] {
  const core = subject.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 4);
  const out: string[] = [];
  if (core.length) out.push(core.join(" "), core.slice(0, 2).join(" "), core[0]!);
  return [...new Set([...out, ...cfg.fallbackImageQueries])];
}

export async function sceneImages(
  cfg: ChannelConfig,
  scenes: { id: string; imageQuery: string; altQueries?: string[]; motion?: string; era?: string; cardHeadline?: string; cardSub?: string }[],
  dir: string, videoId: number, used: Set<string>, fallbacks?: string[], size?: { w: number; h: number },
): Promise<{ files: string[][]; credits: ImageCredit[] }> {
  const fallbackList = fallbacks?.length ? fallbacks : cfg.fallbackImageQueries;
  await fs.mkdir(dir, { recursive: true });
  if (!cfg.imageSources.length) throw new Error(`imageSources must name known sources: ${Object.keys(FINDERS).join(", ")}`);
  /**
   * Source ORDER changes with era; the source LIST never shrinks.
   *
   * Excluding stock for historical scenes left them with archives only, and archive titles are
   * scored by word overlap, which reports nothing for generic terms. Stock genuinely holds
   * "wooden wheel", "old ledger", "rusty hull" — timeless objects and textures that suit a
   * period scene. What must not come from stock is anything visibly modern, and the approved
   * subject list plus the people filter already prevent that.
   */
  const sourceNamesFor = (era?: string): string[] => {
    const all = cfg.imageSources.filter((n) => FINDERS[n]);
    if (era !== "historical") return all;
    const isArchive = (n: string) => n === "commons" || n === "openverse";
    return [...all.filter((n) => isArchive(n)), ...all.filter((n) => !isArchive(n))];
  };
  const namedSourcesFor = (era?: string): [string, (q: string, u: Set<string>, f: string) => Promise<ImageHit | null>][] =>
    sourceNamesFor(era).map((n) => [n, FINDERS[n]!]);
  const sourcesFor = (era?: string) => sourceNamesFor(era).map((n) => FINDERS[n]!);

  // Fetch a small pool of on-topic real footage up front. A scene that misses or stalls takes from
  // this pool, so a slow network produces a real picture rather than a text slide.
  const poolDir = path.join(dir, "pool");
  await fs.mkdir(poolDir, { recursive: true });
  const pool: { file: string; credit: ImageCredit }[] = [];
  const poolQueries = [...(fallbacks ?? []), ...cfg.fallbackImageQueries].filter((q, i, a) => a.indexOf(q) === i).slice(0, 10);
  await mapLimit(poolQueries, 4, async (q, i) => {
    const f = path.join(poolDir, `p${i}.jpg`);
    for (const find of cfg.imageSources.map((n) => FINDERS[n]!).filter(Boolean)) {
      const hit = await find(q, used, f).catch(() => null);
      if (hit) { pool.push({ file: f, credit: { source: hit.source, id: hit.id, title: hit.title, attribution: hit.attribution } }); return; }
    }
  });
  log(`  footage pool: ${pool.length} spare images ready`);
  let poolAt = 0;
  const fromPool = () => (pool.length ? pool[poolAt++ % pool.length]! : null);

  const clipsWanted = Math.round(scenes.length * cfg.videoClipRatio);
  let clipsUsed = 0;

  let done = 0;
  let generated = 0;
  const phaseStart = Date.now();
  const results = await mapLimit(scenes, 6, async (s, i) => {
    // Phase budget spent: stop searching and dress the rest from the pool.
    if (Date.now() - phaseStart > PHASE_BUDGET_MS) {
      const spare = fromPool();
      if (spare) {
        const out = path.join(dir, `${String(i).padStart(3, "0")}.jpg`);
        await fs.copyFile(spare.file, out).catch(() => {});
        return { files: [out], credit: spare.credit };
      }
    }
    // Timed out: use real footage from the pool. A card only if the pool is somehow empty.
    const onTimeout = async () => {
      const spare = fromPool();
      if (spare) {
        const out = path.join(dir, `${String(i).padStart(3, "0")}.jpg`);
        await fs.copyFile(spare.file, out).catch(() => {});
        log(`  scene ${s.id}: search too slow — used pooled footage`);
        return { files: [out], credit: spare.credit };
      }
      throw new Error(`scene ${s.id} found no picture within ${SCENE_BUDGET_MS / 60000} minutes and the pool is empty`);
    };
    return withBudget(findOne(s, i), SCENE_BUDGET_MS, onTimeout).finally(() => {
      done++;
      if (done === 1 || done % 5 === 0 || done === scenes.length) log(`  images ${done}/${scenes.length}`);
    });
  });
  return { files: results.map((r) => r.files), credits: results.map((r) => r.credit) };

  /** A scene needs 2-3 visuals so the render can cut on sentence boundaries. */
  async function findOne(s: (typeof scenes)[number], i: number): Promise<{ files: string[]; credit: ImageCredit }> {
    // The writer marks which lines describe movement; those are the ones worth a real clip.
    const extra: { file: string; credit: ImageCredit }[] = [];
    if (s.motion === "clip" && s.era !== "historical" && clipsUsed < clipsWanted) {
      clipsUsed++;
      const mp4 = path.join(dir, `${String(i).padStart(3, "0")}.mp4`);
      for (const q of [s.imageQuery, ...(s.altQueries ?? [])]) {
        for (const findClip of CLIP_FINDERS) {
          const clip = await findClip(q, used, mp4).catch(() => null);
          if (clip) extra.push({ file: mp4, credit: { source: clip.source, id: clip.id, title: clip.title, attribution: clip.attribution } });
          if (extra.length) break;
        }
      }
      if (!extra.length) clipsUsed--; // no clip found anywhere; fall through to stills
    }
    const file = path.join(dir, `${String(i).padStart(3, "0")}.jpg`);
    const parts = s.imageQuery.split(/\s+/).filter(Boolean);
    const sources = sourcesFor(s.era);
    // The period hint helps archives and actively HURTS stock libraries — "old ledger engraving
    // lithograph archive photograph" finds nothing on Pexels — so it is applied per source, never globally.
    const named = namedSourcesFor(s.era);
    const archival = (n: string) => n === "commons" || n === "openverse";
    const hintFor = (n: string) => (s.era === "historical" && archival(n) ? ` ${HISTORICAL_HINT}` : "");
    const queries = [s.imageQuery, ...(s.altQueries ?? []), parts.slice(0, 2).join(" ")]
      .filter((q, j, a) => q && a.indexOf(q) === j);

    let best: ImageHit | null = null;
    outer: for (const q of queries) {
      for (const [name, find] of named) {
        const got = await find(q + hintFor(name), used, file).catch(() => null);
        if (got && (!best || got.score > best.score)) best = got;
        if (best && best.score >= 0.5) break outer; // clearly on-topic
      }
    }
    // Try on-topic fallbacks (another photo of the subject) before giving up on a photo entirely.
    if (!best || best.score < MIN_USABLE) {
      for (const q of fallbackList) {
        const alt = await sources.reduce<Promise<ImageHit | null>>(
          async (acc, find) => (await acc) ?? (await find(q, used, file).catch(() => null)), Promise.resolve(null));
        if (alt && alt.score >= MIN_USABLE) { best = alt; break; }
      }
    }
    // No text cards, ever. Exhaust every source and query before giving up on a real picture.
    if (!best || best.score < MIN_USABLE) {
      for (const q of [...(s.altQueries ?? []), s.imageQuery, ...fallbackList]) {
        for (const find of sources) {
          const any = await find(q, used, file).catch(() => null);
          if (any && (!best || any.score > best.score)) best = any;
          if (best && best.score >= MIN_USABLE) break;
        }
        if (best && best.score >= MIN_USABLE) break;
      }
    }
    // Last resort before the pool: generate a clip, if enabled and under the per-run cap.
    if (!best && process.env.AI_CLIPS === "true" && generated < Number(process.env.AI_CLIPS_MAX ?? 4)) {
      const mp4 = path.join(dir, `${String(i).padStart(3, "0")}gen.mp4`);
      const gen = await generatedClip(s.imageQuery, used, mp4).catch(() => null);
      if (gen) {
        generated++;
        log(`  scene ${s.id}: no footage existed — generated a clip (${generated}/${process.env.AI_CLIPS_MAX ?? 4})`);
        return { files: [mp4], credit: { source: gen.source, id: gen.id, title: gen.title } };
      }
    }
    // Still nothing of our own: take from the prefetched pool of real footage.
    if (!best) {
      const spare = fromPool();
      if (spare) {
        await fs.copyFile(spare.file, file).catch(() => {});
        log(`  scene ${s.id}: no match found — used pooled footage`);
        return { files: [file], credit: spare.credit };
      }
      throw new Error(`no image found for scene ${s.id} ("${s.imageQuery}") from any source`);
    }
    // Collect 1-2 more visuals for this scene from its alternative queries, so the render can cut.
    // Each scene needs 3 distinct visuals so the shot cuts land on something new. Any real hit
    // beats repeating the same frame, so the bar here is lower than for the scene's lead image.
    const files = [file];
    const WANT = 3;
    for (const q of (s.altQueries ?? []).slice(0, 3)) {
      if (files.length >= WANT) break;
      const more = path.join(dir, `${String(i).padStart(3, "0")}b${files.length}.jpg`);
      for (const find of sources) {
        const hit = await find(q, used, more).catch(() => null);
        if (hit) { files.push(more); break; }
      }
    }
    while (files.length < WANT) {
      const spare = fromPool();
      if (!spare) break;
      const more = path.join(dir, `${String(i).padStart(3, "0")}b${files.length}.jpg`);
      await fs.copyFile(spare.file, more).catch(() => {});
      files.push(more);
    }
    return { files: [...extra.map((e) => e.file), ...files], credit: { source: best.source, id: best.id, title: best.title, attribution: best.attribution } };
  }
}
