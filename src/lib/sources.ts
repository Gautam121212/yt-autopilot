/** Free data sources: Wikipedia (research), NASA Image Library (visuals), YouTube search (demand signals). */
import fs from "node:fs/promises";
import { fetchOk, withRetry } from "./http";
import { yt } from "./youtube";

const UA = `yt-autopilot/1.0 (https://github.com/${process.env.GITHUB_REPOSITORY ?? "local"})`;
const getJson = async <T>(url: string): Promise<T> =>
  (await withRetry(() => fetchOk(url, { method: "GET", headers: { "User-Agent": UA } }), url)).json() as Promise<T>;

// ---------- Wikipedia ----------
export type WikiPage = { title: string; url: string; text: string };

export async function wikiPages(queries: string[], maxChars = 14000): Promise<WikiPage[]> {
  const out: WikiPage[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const s = await getJson<{ query?: { search?: { title: string }[] } }>(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=2&format=json&srsearch=${encodeURIComponent(q)}`,
    );
    for (const { title } of s.query?.search ?? []) {
      if (seen.has(title)) continue;
      seen.add(title);
      const p = await getJson<{ query?: { pages?: Record<string, { title: string; extract?: string; fullurl?: string }> } }>(
        `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&explaintext=1&inprop=url&redirects=1&format=json&titles=${encodeURIComponent(title)}`,
      );
      for (const page of Object.values(p.query?.pages ?? {})) {
        if (page.extract && page.fullurl) {
          const text = page.extract.split(/\n==\s*(See also|References|External links|Notes|Further reading)\s*==/)[0]!;
          out.push({ title: page.title, url: page.fullurl, text: text.slice(0, maxChars) });
        }
      }
    }
  }
  return out;
}

// ---------- NASA Image and Video Library (no key needed) ----------
type NasaItem = { data: { nasa_id: string; title?: string; description?: string; keywords?: string[]; photographer?: string; secondary_creator?: string }[] };

// NASA imagery is usable for informational content, but NOT: identifiable people (publicity rights),
// NASA logos/insignia, or third-party copyrighted items hosted on NASA sites.
const PEOPLE = /\b(astronauts?|crew|portrait|headshot|employees?|administrator|ceremony|press conference|briefing|visitors?|students?|interns?|award|people|person|family|signing|speaks|speech|panel|meeting|interview|selfie|officials?|engineers?|technicians?|team|personnel|staff|worker|delegation|group photo)\b/i;
const MARKS = /\b(logo|insignia|meatball|worm|patch|emblem|seal|badge|banner|poster|signage|billboard|livery|branding|trademark|mission decal|name ?tag|uniform)\b/i;
const THIRD_PARTY = /©|copyright|courtesy of/i;

const STOP = new Set(["the", "a", "an", "of", "in", "on", "and", "view", "picture", "image", "photo", "shot", "scene", "surface"]);
const words = (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Finds a usable NASA image for `query` and reports how well it matched, so callers can
 * retry with a broader query instead of silently shipping an unrelated picture.
 */
export async function nasaImage(query: string, used: Set<string>, file: string): Promise<ImageHit | null> {
  const terms = words(query);
  const s = await getJson<{ collection: { items: NasaItem[] } }>(
    `https://images-api.nasa.gov/search?media_type=image&page_size=60&q=${encodeURIComponent(query)}`,
  );
  const candidates = s.collection.items
    .map((i) => i.data[0]!)
    .filter((d) => d && !used.has(d.nasa_id))
    .filter((d) => {
      const meta = `${d.title ?? ""} ${d.description ?? ""} ${(d.keywords ?? []).join(" ")}`;
      return !PEOPLE.test(meta) && !MARKS.test(meta) && !THIRD_PARTY.test(`${meta} ${d.photographer ?? ""} ${d.secondary_creator ?? ""}`);
    })
    .map((d) => {
      // Score on how many of the query's words appear, title weighted over description/keywords.
      const title = (d.title ?? "").toLowerCase();
      const rest = `${d.description ?? ""} ${(d.keywords ?? []).join(" ")}`.toLowerCase();
      const hits = terms.filter((t) => title.includes(t)).length * 2 + terms.filter((t) => rest.includes(t)).length;
      return { d, score: terms.length ? hits / (terms.length * 2) : 0 };
    })
    .sort((a, b) => b.score - a.score);

  for (const { d, score } of candidates.slice(0, 6)) {
    if (used.has(d.nasa_id)) continue;
    used.add(d.nasa_id); // reserve synchronously so parallel scenes never pick the same image
    const assets = await getJson<{ collection: { items: { href: string }[] } }>(`https://images-api.nasa.gov/asset/${encodeURIComponent(d.nasa_id)}`);
    const hrefs = assets.collection.items.map((a) => a.href);
    const href = ["~large.jpg", "~medium.jpg", "~orig.jpg"].map((suf) => hrefs.find((h) => h.endsWith(suf))).find(Boolean);
    if (!href) { used.delete(d.nasa_id); continue; }
    const res = await fetch(encodeURI(decodeURI(href)).replace(/^http:/, "https:"), { headers: { "User-Agent": UA } }).catch(() => null);
    if (!res?.ok) { used.delete(d.nasa_id); continue; }
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    return { source: "nasa", id: d.nasa_id, title: d.title ?? d.nasa_id, score: +score.toFixed(2) };
  }
  return null;
}

// ---------- Wikimedia Commons (any topic, licence-filtered) ----------
export type ImageHit = { source: "nasa" | "commons" | "pexels"; id: string; title: string; score: number; attribution?: string };

type CommonsPage = {
  title: string;
  imageinfo?: {
    url: string; thumburl?: string; width: number; height: number; mime: string;
    extmetadata?: Record<string, { value?: string }>;
  }[];
};

// Only licences that allow commercial reuse. Everything else (fair use, non-commercial, ND) is skipped.
const FREE_LICENCE = /^(cc0|cc-zero|public domain|pd-|cc by 4\.0|cc by-sa|cc by 3\.0|cc by 2\.|cc by 1\.0|cc-by|attribution)/i;
const BAD_LICENCE = /(fair use|non-?free|nc\b|non-?commercial|nd\b|no ?derivatives)/i;
const stripHtml = (h: string) => h.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/**
 * Finds a freely reusable Commons image for `query`. Returns the attribution string the
 * description must carry for CC-BY / CC-BY-SA works.
 */
export async function commonsImage(query: string, used: Set<string>, file: string): Promise<ImageHit | null> {
  const terms = words(query.replace(HISTORICAL_HINT, ""));
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search` +
    `&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}&gsrnamespace=6&gsrlimit=40` +
    `&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1920`;
  const res = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(api);
  const pages = Object.values(res.query?.pages ?? {});

  const scored = pages
    .map((p) => {
      const info = p.imageinfo?.[0];
      const meta = info?.extmetadata ?? {};
      const licence = stripHtml(meta.LicenseShortName?.value ?? meta.License?.value ?? "");
      const usage = stripHtml(meta.UsageTerms?.value ?? "");
      const artist = stripHtml(meta.Artist?.value ?? meta.Credit?.value ?? "");
      const restrictions = stripHtml(meta.Restrictions?.value ?? "");
      const title = p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ");
      const hay = `${title} ${stripHtml(meta.ImageDescription?.value ?? "")} ${stripHtml(meta.Categories?.value ?? "")}`.toLowerCase();
      const hits = terms.filter((t) => title.toLowerCase().includes(t)).length * 2 + terms.filter((t) => hay.includes(t)).length;
      return { p, info, title, licence, usage, artist, restrictions, score: terms.length ? hits / (terms.length * 2) : 0 };
    })
    .filter((c) =>
      c.info && /^image\/(jpeg|png|webp)$/.test(c.info.mime) && (c.info.width ?? 0) >= 1000 &&
      !BAD_LICENCE.test(`${c.licence} ${c.usage}`) && FREE_LICENCE.test(c.licence) &&
      !c.restrictions && !PEOPLE.test(`${c.title} ${c.usage}`) && !MARKS.test(c.title))
    .sort((a, b) => b.score - a.score);

  for (const c of scored.slice(0, 6)) {
    const id = c.p.title;
    if (used.has(id)) continue;
    used.add(id);
    const url = c.info!.thumburl ?? c.info!.url;
    const r = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
    if (!r?.ok) { used.delete(id); continue; }
    await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
    const needsCredit = /cc[ -]?by/i.test(c.licence);
    return {
      source: "commons",
      id,
      title: c.title,
      score: +c.score.toFixed(2),
      attribution: needsCredit
        ? `${c.title} — ${c.artist || "Wikimedia Commons"} — ${c.licence} — https://commons.wikimedia.org/wiki/${encodeURIComponent(id)}`
        : undefined,
    };
  }
  return null;
}

// ---------- Pexels (free stock photos and video, key required) ----------
type PexelsPhoto = { id: number; alt?: string; width: number; photographer?: string; url?: string; src: { large2x?: string; large?: string; original?: string } };
type PexelsVideo = { id: number; width: number; height: number; duration: number; user?: { name?: string }; url?: string; video_files: { link: string; width: number; height: number; file_type: string }[] };

const pexelsKey = () => process.env.PEXELS_API_KEY ?? "";

export async function pexelsImage(query: string, used: Set<string>, file: string): Promise<ImageHit | null> {
  if (!pexelsKey()) return null;
  const terms = words(query);
  const r = await fetch(`https://api.pexels.com/v1/search?per_page=30&orientation=landscape&size=large&query=${encodeURIComponent(query)}`,
    { headers: { Authorization: pexelsKey() } }).catch(() => null);
  if (!r?.ok) return null;
  const { photos = [] } = (await r.json()) as { photos?: PexelsPhoto[] };
  const scored = photos
    .filter((p) => p.width >= 1600 && !used.has(`pexels:${p.id}`))
    .map((p) => {
      const alt = (p.alt ?? "").toLowerCase();
      const hits = terms.filter((t) => alt.includes(t)).length * 2;
      return { p, score: terms.length ? hits / (terms.length * 2) : 0 };
    })
    .sort((a, b) => b.score - a.score);

  for (const { p, score } of scored.slice(0, 5)) {
    const id = `pexels:${p.id}`;
    if (used.has(id)) continue;
    used.add(id);
    const url = p.src.large2x ?? p.src.large ?? p.src.original;
    const res = url ? await fetch(url).catch(() => null) : null;
    if (!res?.ok) { used.delete(id); continue; }
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    return {
      source: "pexels", id, title: p.alt || `Pexels photo ${p.id}`, score: +score.toFixed(2),
      attribution: `Photo by ${p.photographer ?? "Pexels"} on Pexels${p.url ? ` — ${p.url}` : ""}`,
    };
  }
  return null;
}

/** Short landscape clip for scenes that benefit from motion. Returns an .mp4 path in `file`. */
export async function pexelsVideo(query: string, used: Set<string>, file: string): Promise<ImageHit | null> {
  if (!pexelsKey()) return null;
  const r = await fetch(`https://api.pexels.com/videos/search?per_page=20&orientation=landscape&size=medium&query=${encodeURIComponent(query)}`,
    { headers: { Authorization: pexelsKey() } }).catch(() => null);
  if (!r?.ok) return null;
  const { videos = [] } = (await r.json()) as { videos?: PexelsVideo[] };
  for (const v of videos.filter((v) => v.duration >= 5 && v.duration <= 60 && !used.has(`pexelsv:${v.id}`)).slice(0, 5)) {
    const id = `pexelsv:${v.id}`;
    used.add(id);
    const f = v.video_files
      .filter((x) => x.file_type === "video/mp4" && x.width >= 1280 && x.width <= 2560)
      .sort((a, b) => b.width - a.width)[0];
    const res = f ? await fetch(f.link).catch(() => null) : null;
    if (!res?.ok) { used.delete(id); continue; }
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    return {
      source: "pexels", id, title: `Pexels video ${v.id}`, score: 0.6,
      attribution: `Video by ${v.user?.name ?? "Pexels"} on Pexels${v.url ? ` — ${v.url}` : ""}`,
    };
  }
  return null;
}

// ---------- Feasibility probe ----------
/**
 * How well a query would match, WITHOUT downloading anything. Used before production to catch
 * queries no archive can satisfy, which is the main cause of mismatched pictures.
 */
export async function probeQuery(query: string, era: "historical" | "modern" | "any" = "any"): Promise<{ score: number; best: string }> {
  const terms = words(query);
  if (!terms.length) return { score: 0, best: "" };
  const q = era === "historical" ? `${query} ${HISTORICAL_HINT}` : query;
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search` +
    `&gsrsearch=${encodeURIComponent(`filetype:bitmap ${q}`)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=size|mime|extmetadata`;
  const res = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(api).catch(() => null);
  let best = { score: 0, best: "" };
  for (const p of Object.values(res?.query?.pages ?? {})) {
    const title = p.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ");
    const hits = terms.filter((t) => title.toLowerCase().includes(t)).length * 2;
    const score = hits / (terms.length * 2);
    if (score > best.score) best = { score: +score.toFixed(2), best: title };
  }
  return best;
}

export const HISTORICAL_HINT = "19th century engraving lithograph vintage photograph";

// ---------- YouTube demand signals ----------
export type Outlier = { title: string; channel: string; views: number; subs: number; ratio: number; ageDays: number };

/**
 * Finds recent videos that massively outperformed their channel's size.
 * High views/subscribers ratio = the TOPIC pulled the audience, not the channel's existing fans.
 * Quota: ~100 units per query (daily budget is 10,000).
 */
export async function findOutliers(queries: string[], lookbackDays: number, minViews: number): Promise<Outlier[]> {
  const api = yt();
  const after = new Date(Date.now() - lookbackDays * 86400e3).toISOString();
  const ids = new Set<string>();
  for (const q of queries) {
    const r = await api.search.list({ part: ["id"], q, type: ["video"], order: "viewCount", publishedAfter: after, maxResults: 25, relevanceLanguage: "en", videoDuration: "medium" });
    for (const i of r.data.items ?? []) if (i.id?.videoId) ids.add(i.id.videoId);
  }
  if (!ids.size) return [];
  const vids = (await api.videos.list({ part: ["snippet", "statistics"], id: [...ids].slice(0, 50) })).data.items ?? [];
  const chanIds = [...new Set(vids.map((v) => v.snippet?.channelId).filter((x): x is string => !!x))];
  const subs = new Map<string, number>();
  for (let i = 0; i < chanIds.length; i += 50) {
    const c = await api.channels.list({ part: ["statistics"], id: chanIds.slice(i, i + 50) });
    for (const ch of c.data.items ?? []) subs.set(ch.id!, Number(ch.statistics?.subscriberCount ?? 0));
  }
  return vids
    .map((v) => {
      const views = Number(v.statistics?.viewCount ?? 0);
      const s = subs.get(v.snippet?.channelId ?? "") ?? 0;
      return {
        title: v.snippet?.title ?? "",
        channel: v.snippet?.channelTitle ?? "",
        views,
        subs: s,
        ratio: +(views / Math.max(s, 1000)).toFixed(2),
        ageDays: Math.round((Date.now() - new Date(v.snippet?.publishedAt ?? Date.now()).getTime()) / 86400e3),
      };
    })
    .filter((o) => o.views >= minViews)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 25);
}
