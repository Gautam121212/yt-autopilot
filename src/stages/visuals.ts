import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelConfig } from "../config";
import { incident } from "../lib/log";
import { mapLimit } from "../lib/media";
import { log } from "../lib/log";
import { commonsImage, HISTORICAL_HINT, nasaImage, openverseImage, pexelsImage, pexelsVideo, type ImageHit } from "../lib/sources";
import { makeCard } from "./cards";

export type ImageCredit = { source: string; id: string; title: string; attribution?: string };

const MIN_USABLE = 0.25;        // below this, a designed card beats whatever the archive returned
const SCENE_BUDGET_MS = Number(process.env.SCENE_BUDGET_MS ?? 180_000); // ceiling per scene before a card is used

function withBudget<T>(p: Promise<T>, ms: number, fallback: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), ms); });
  return Promise.race([p, timeout]).then((r) => (r === "timeout" ? fallback() : (r as T))).finally(() => clearTimeout(timer));
}

const FINDERS: Record<string, (q: string, used: Set<string>, file: string) => Promise<ImageHit | null>> = {
  commons: commonsImage,
  openverse: openverseImage,
  nasa: nasaImage,
  pexels: pexelsImage,
};

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
): Promise<{ files: string[]; credits: ImageCredit[] }> {
  const fallbackList = fallbacks?.length ? fallbacks : cfg.fallbackImageQueries;
  await fs.mkdir(dir, { recursive: true });
  if (!cfg.imageSources.length) throw new Error(`imageSources must name known sources: ${Object.keys(FINDERS).join(", ")}`);
  // Pexels is modern stock; a 19th-century subject must never be illustrated from it.
  const sourcesFor = (era?: string) =>
    cfg.imageSources.filter((n) => !(era === "historical" && n === "pexels")).map((n) => FINDERS[n]!).filter(Boolean);

  const clipsWanted = Math.round(scenes.length * cfg.videoClipRatio);
  let clipsUsed = 0;

  let done = 0;
  const results = await mapLimit(scenes, 6, async (s, i) => {
    const card = async () => {
      const out = path.join(dir, `${String(i).padStart(3, "0")}-card.jpg`);
      await makeCard({ headline: s.cardHeadline || s.imageQuery, sub: s.cardSub, index: i, width: size?.w ?? 1920, height: size?.h ?? 1080, out });
      await incident("visuals.slow", new Error(`scene ${s.id} took over ${SCENE_BUDGET_MS / 1000}s to find a picture — used a card`), videoId);
      return { file: out, credit: { source: "card", id: `card-${s.id}`, title: s.cardHeadline || s.imageQuery } };
    };
    return withBudget(findOne(s, i), SCENE_BUDGET_MS, card).finally(() => {
      done++;
      if (done === 1 || done % 5 === 0 || done === scenes.length) log(`  images ${done}/${scenes.length}`);
    });
  });
  return { files: results.map((r) => r.file), credits: results.map((r) => r.credit) };

  async function findOne(s: (typeof scenes)[number], i: number) {
    // The writer marks which lines describe movement; those are the ones worth a real clip.
    if (process.env.PEXELS_API_KEY && s.motion === "clip" && s.era !== "historical" && clipsUsed < clipsWanted) {
      clipsUsed++;
      const mp4 = path.join(dir, `${String(i).padStart(3, "0")}.mp4`);
      for (const q of [s.imageQuery, ...(s.altQueries ?? [])]) {
        const clip = await pexelsVideo(q, used, mp4).catch(() => null);
        if (clip) return { file: mp4, credit: { source: clip.source, id: clip.id, title: clip.title, attribution: clip.attribution } };
      }
      clipsUsed--; // no clip found; fall through to a still
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
    // Still nothing honest? Render a card from the scene's own words — always relevant, always licence-clean.
    if (!best || best.score < MIN_USABLE) {
      const card = path.join(dir, `${String(i).padStart(3, "0")}-card.jpg`);
      await makeCard({
        headline: s.cardHeadline || s.imageQuery,
        sub: s.cardSub,
        index: i,
        width: size?.w ?? 1920,
        height: size?.h ?? 1080,
        out: card,
      });
      await incident("visuals.card", new Error(`no archive match for "${s.imageQuery}" — rendered a card instead`), videoId);
      return { file: card, credit: { source: "card", id: `card-${s.id}`, title: s.cardHeadline || s.imageQuery } };
    }
    return { file, credit: { source: best.source, id: best.id, title: best.title, attribution: best.attribution } };
  }
}
