import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelConfig } from "../config";
import { incident } from "../lib/log";
import { mapLimit } from "../lib/media";
import { log } from "../lib/log";
import {
  commonsImage, HISTORICAL_HINT, nasaImage, openverseImage, pexelsImage, pexelsVideo,
  pixabayImage, pixabayVideo, type ImageHit,
} from "../lib/sources";

export type ImageCredit = { source: string; id: string; title: string; attribution?: string };

const MIN_USABLE = 0.25;
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
  nasa: nasaImage,
};

/** Every video source, tried in order, for scenes the writer marked as motion. */
const CLIP_FINDERS = [pexelsVideo, pixabayVideo];

/** Fetch a different image for one scene, avoiding everything already used in this video. */
export async function replaceSceneImage(
  cfg: ChannelConfig, scene: { id: string; imageQuery: string; altQueries?: string[]; era?: string }, file: string, used: Set<string>, videoId: number, fallbacks?: string[],
): Promise<ImageCredit | null> {
  const sources = cfg.imageSources.filter((n) => !(scene.era === "historical" && n === "pexels")).map((n) => FINDERS[n]!).filter(Boolean);
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
  // Pexels is modern stock; a 19th-century subject must never be illustrated from it.
  const sourcesFor = (era?: string) =>
    cfg.imageSources.filter((n) => !(era === "historical" && n === "pexels")).map((n) => FINDERS[n]!).filter(Boolean);

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
    const hint = s.era === "historical" ? ` ${HISTORICAL_HINT}` : "";
    const queries = [s.imageQuery + hint, ...(s.altQueries ?? []).map((q) => q + hint), parts.slice(0, 2).join(" ")]
      .filter((q, j, a) => q && a.indexOf(q) === j);

    let best: ImageHit | null = null;
    outer: for (const q of queries) {
      for (const find of sources) {
        const got = await find(q, used, file).catch(() => null);
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
    const files = [file];
    for (const q of (s.altQueries ?? []).slice(0, 2)) {
      const more = path.join(dir, `${String(i).padStart(3, "0")}b${files.length}.jpg`);
      for (const find of sources) {
        const hit = await find(q + (s.era === "historical" ? ` ${HISTORICAL_HINT}` : ""), used, more).catch(() => null);
        if (hit && hit.score >= MIN_USABLE) { files.push(more); break; }
      }
      if (files.length >= 3) break;
    }
    if (files.length === 1) {
      const spare = fromPool();
      if (spare) {
        const more = path.join(dir, `${String(i).padStart(3, "0")}b1.jpg`);
        await fs.copyFile(spare.file, more).catch(() => {});
        files.push(more);
      }
    }
    return { files: [...extra.map((e) => e.file), ...files], credit: { source: best.source, id: best.id, title: best.title, attribution: best.attribution } };
  }
}
