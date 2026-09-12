import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelConfig } from "../config";
import { incident } from "../lib/log";
import { mapLimit } from "../lib/media";
import { commonsImage, HISTORICAL_HINT, nasaImage, pexelsImage, pexelsVideo, type ImageHit } from "../lib/sources";

export type ImageCredit = { source: string; id: string; title: string; attribution?: string };

const FINDERS: Record<string, (q: string, used: Set<string>, file: string) => Promise<ImageHit | null>> = {
  commons: commonsImage,
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
  cfg: ChannelConfig, scenes: { id: string; imageQuery: string; altQueries?: string[]; motion?: string; era?: string }[],
  dir: string, videoId: number, used: Set<string>, fallbacks?: string[],
): Promise<{ files: string[]; credits: ImageCredit[] }> {
  const fallbackList = fallbacks?.length ? fallbacks : cfg.fallbackImageQueries;
  await fs.mkdir(dir, { recursive: true });
  if (!cfg.imageSources.length) throw new Error(`imageSources must name known sources: ${Object.keys(FINDERS).join(", ")}`);
  // Pexels is modern stock; a 19th-century subject must never be illustrated from it.
  const sourcesFor = (era?: string) =>
    cfg.imageSources.filter((n) => !(era === "historical" && n === "pexels")).map((n) => FINDERS[n]!).filter(Boolean);

  const clipsWanted = Math.round(scenes.length * cfg.videoClipRatio);
  let clipsUsed = 0;

  const results = await mapLimit(scenes, 4, async (s, i) => {
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
    // A confidently wrong picture is worse than a neutral one: below 0.3 prefer the fallback set.
    if (best && best.score < 0.3) best = null;
    if (!best) {
      for (const q of fallbackList) {
        for (const find of sources) {
          best = await find(q, used, file).catch(() => null);
          if (best) break;
        }
        if (best) break;
      }
    }
    if (!best) throw new Error(`no usable image for scene ${s.id} ("${s.imageQuery}")`);
    if (best.score < 0.5) {
      await incident("visuals.weak-match", new Error(`"${s.imageQuery}" -> "${best.title}" (${best.source}, score ${best.score})`), videoId);
    }
    return { file, credit: { source: best.source, id: best.id, title: best.title, attribution: best.attribution } };
  });
  return { files: results.map((r) => r.file), credits: results.map((r) => r.credit) };
}
