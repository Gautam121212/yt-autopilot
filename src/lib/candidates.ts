/**
 * Candidate footage for a scene: many options, cheaply, so something can CHOOSE between them.
 *
 * The old path kept ONE result per search (ranked by caption word-overlap, which bug #5 showed is
 * meaningless — stock captions are synonyms or empty) and asked a judge to rate it in isolation. The
 * other 29 results per search were thrown away unseen. Here we keep the library's own ranking, which
 * is far better than ours, collect thumbnails from several searches, and hand the lot to an editor.
 *
 * Only thumbnails are fetched at this stage (~20-60 KB each). Full resolution is downloaded for the
 * few that are actually chosen.
 */
import fs from "node:fs/promises";
import { resetPexelsBudget, takePexels } from "./budget";
import { hfetch } from "./http";
import { isPlayable } from "./media";
import { MIN_IMG_W, MIN_VID_W } from "./sources";

export type Candidate = {
  key: string;                // same id scheme as the fetchers, so `used` dedupes across both paths
  source: "pexels" | "pixabay";
  kind: "photo" | "video";
  thumb: string;
  full: string;
  caption: string;
  credit?: string;
  query: string;
};

// Faces as the SUBJECT are off-brand. Hands working, crowds at a distance and so on are fine — the
// old caption filter also rejected "hands", which excluded exactly the shots the approved list asks for.
const PORTRAIT = /\b(portrait|selfie|posing|model|headshot|smiling|face)\b/i;

const pexelsKey = () => process.env.PEXELS_API_KEY ?? "";
const pixKey = () => process.env.PIXABAY_API_KEY ?? "";

/** One budget shared with every other stage that calls Pexels (see lib/budget.ts). */
let pexelsCalls = 0;
const pexelsOk = () => takePexels();

/** The same search is often needed by several scenes; ask each library once per run. */
const cache = new Map<string, Candidate[]>();

export type Orientation = "landscape" | "portrait";

async function pexelsPhotos(query: string, n: number, orient: Orientation): Promise<Candidate[]> {
  if (!pexelsOk()) return [];
  pexelsCalls++; // this module's share, for diagnostics
  const r = await hfetch(`https://api.pexels.com/v1/search?per_page=${n}&orientation=${orient}&query=${encodeURIComponent(query)}`,
    { headers: { Authorization: pexelsKey() } }, 20_000).catch(() => null);
  if (!r?.ok) return [];
  const { photos = [] } = (await r.json().catch(() => ({}))) as {
    photos?: { id: number; width: number; alt?: string; photographer?: string; url?: string;
      src: { medium?: string; large?: string; large2x?: string; original?: string } }[];
  };
  // A vertical photo is narrower than it is tall, so the width floor applies to its short side.
  const minW = orient === "portrait" ? Math.round(MIN_IMG_W * 0.56) : MIN_IMG_W;
  return photos
    .filter((p) => p.width >= minW && !PORTRAIT.test(p.alt ?? "") && (p.src.medium || p.src.large))
    .map((p) => ({
      key: `pexels:${p.id}`, source: "pexels" as const, kind: "photo" as const, query,
      thumb: p.src.medium ?? p.src.large!, full: p.src.large2x ?? p.src.large ?? p.src.original!,
      caption: p.alt ?? "", credit: `Photo by ${p.photographer ?? "Pexels"} on Pexels${p.url ? ` — ${p.url}` : ""}`,
    }));
}

async function pexelsVideos(query: string, n: number, orient: Orientation): Promise<Candidate[]> {
  if (!pexelsOk()) return [];
  pexelsCalls++; // this module's share, for diagnostics
  const r = await hfetch(`https://api.pexels.com/videos/search?per_page=${n}&orientation=${orient}&query=${encodeURIComponent(query)}`,
    { headers: { Authorization: pexelsKey() } }, 20_000).catch(() => null);
  if (!r?.ok) return [];
  const { videos = [] } = (await r.json().catch(() => ({}))) as {
    videos?: { id: number; duration: number; image?: string; url?: string; user?: { name?: string };
      video_files: { link: string; width: number; file_type: string }[] }[];
  };
  const out: Candidate[] = [];
  for (const v of videos) {
    if (v.duration < 4 || v.duration > 60 || !v.image) continue;
    const minVW = orient === "portrait" ? Math.round(MIN_VID_W * 0.56) : MIN_VID_W;
    const f = v.video_files.filter((x) => x.file_type === "video/mp4" && x.width >= minVW && x.width <= 2560)
      .sort((a, b) => b.width - a.width)[0];
    if (!f) continue;
    out.push({
      key: `pexelsv:${v.id}`, source: "pexels", kind: "video", query,
      thumb: v.image, full: f.link, caption: `video ${v.id}`,
      credit: `Video by ${v.user?.name ?? "Pexels"} on Pexels${v.url ? ` — ${v.url}` : ""}`,
    });
  }
  return out;
}

async function pixabayPhotos(query: string, n: number, orient: Orientation): Promise<Candidate[]> {
  if (!pixKey()) return [];
  const r = await hfetch(`https://pixabay.com/api/?key=${pixKey()}&q=${encodeURIComponent(query)}` +
    `&image_type=photo&orientation=${orient === "portrait" ? "vertical" : "horizontal"}&per_page=${Math.max(3, n)}&safesearch=true`, {}, 20_000).catch(() => null);
  if (!r?.ok) return [];
  const { hits = [] } = (await r.json().catch(() => ({}))) as {
    hits?: { id: number; imageWidth: number; tags?: string; webformatURL?: string; largeImageURL?: string; fullHDURL?: string }[];
  };
  const minW = orient === "portrait" ? Math.round(MIN_IMG_W * 0.56) : MIN_IMG_W;
  return hits
    .filter((h) => h.imageWidth >= minW && !PORTRAIT.test(h.tags ?? "") && h.webformatURL)
    .map((h) => ({
      key: `px:${h.id}`, source: "pixabay" as const, kind: "photo" as const, query,
      thumb: h.webformatURL!, full: h.fullHDURL ?? h.largeImageURL ?? h.webformatURL!, caption: h.tags ?? "",
    }));
}

/**
 * Up to `max` distinct, unused candidates drawn from several searches, interleaved so no single
 * query dominates the sheet. Videos are included when the scene describes motion.
 */
export async function gatherCandidates(queries: string[], used: Set<string>,
  o: { wantVideo: boolean; perQuery?: number; max?: number; orientation?: Orientation }): Promise<Candidate[]> {
  const orient = o.orientation ?? "landscape";
  const per = o.perQuery ?? 5;
  const lists: Candidate[][] = [];
  for (const q of [...new Set(queries.map((x) => x.trim()).filter(Boolean))].slice(0, 4)) {
    const ck = `${q}|${o.wantVideo}|${orient}`;
    if (!cache.has(ck)) {
      const [a, b, c] = await Promise.all([
        pexelsPhotos(q, per, orient),
        pixabayPhotos(q, per, orient),
        o.wantVideo ? pexelsVideos(q, Math.ceil(per / 2), orient) : Promise.resolve([]),
      ]);
      // videos first when motion is wanted: a moving shot beats a still for that scene
      cache.set(ck, [...c, ...a, ...b]);
    }
    lists.push(cache.get(ck)!);
  }
  // round-robin across queries so the sheet is varied
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < (o.max ?? 9); i++) {
    let added = false;
    for (const l of lists) {
      const c = l[i];
      if (!c) continue;
      added = true;
      if (seen.has(c.key) || used.has(c.key)) continue;
      seen.add(c.key);
      out.push(c);
      if (out.length >= (o.max ?? 9)) break;
    }
    if (!added) break;
  }
  return out;
}

/** Downloads the chosen candidate at full resolution. False if it could not be used. */
export async function downloadCandidate(c: Candidate, file: string): Promise<boolean> {
  const res = await hfetch(c.full, {}, c.kind === "video" ? 90_000 : 45_000).catch(() => null);
  if (!res?.ok) return false;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < (c.kind === "video" ? 200_000 : 20_000)) return false; // truncated
  await fs.writeFile(file, bytes);
  if (c.kind === "video" && !(await isPlayable(file, 2))) return false;
  return true;
}

/** Fetches a thumbnail for the contact sheet. */
export async function fetchThumb(c: Candidate, file: string): Promise<boolean> {
  const res = await hfetch(c.thumb, {}, 20_000).catch(() => null);
  if (!res?.ok) return false;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1_000) return false;
  await fs.writeFile(file, bytes);
  return true;
}

/** For tests and for `npm run why`. */
export const candidateStats = () => ({ pexelsCalls, cachedSearches: cache.size });
export const resetCandidateState = () => { pexelsCalls = 0; cache.clear(); resetPexelsBudget(); };
