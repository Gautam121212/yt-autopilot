/**
 * Clipper M3 — discover.
 *
 * YouTube Data API v3 wrapper. Finds candidate videos to clip, no bot-check (API endpoints
 * are separate from the player endpoints yt-dlp hits — the API serves JSON to anyone with a key).
 *
 * Three source types, union-ed and ranked:
 *   1. `trending` — videos.list?chart=mostPopular per region. YouTube's own "what's hot right now".
 *   2. `category` — videos.list?chart=mostPopular with videoCategoryId filter. Narrows to niches.
 *   3. `channels` — search.list per channel, order=date, then videos.list for stats. Watches
 *      curated creators regardless of category.
 *
 * All results pass through a filter pass (duration band, min views, min view-to-days-old ratio to
 * favor fresh virals), then rank by "own-channel median multiple" (the /yt-viral logic). Results
 * excluded if their videoId is in the reviewed-blacklist (state.ts).
 *
 * API quota math (10k units/day free):
 *   - videos.list chart=mostPopular: 1 unit/call, up to 50 ids/call
 *   - search.list: 100 units/call
 *   - Typical daily discovery: ~20-50 units. Comfortable headroom.
 */
import { fetchOk } from "../http.js";
import { isReviewed } from "./state.js";

/** YouTube category IDs — the "attracted to" niches by default. See: https://developers.google.com/youtube/v3/docs/videoCategories/list */
export const DEFAULT_CATEGORIES = {
  "entertainment": "24",   // Mr. Beast / variety / reaction content
  "comedy":        "23",   // standup, sketches
  "people-blogs":  "22",   // podcasts, interviews, vlogs — big one for clipping
  "news-politics": "25",   // commentary, debates
  "sports":        "17",   // highlights, interviews
  "music":         "10",   // music & artist clips
  "gaming":        "20",   // streamer clips
  "education":     "27",   // explainers, lectures
} as const;

export type DiscoverConfig = {
  apiKey: string;
  regionCodes: string[];                          // e.g. ["IN", "US", "GB"]
  categoryIds?: string[];                         // category.values from DEFAULT_CATEGORIES
  channelIds?: string[];                          // UC... IDs for curated channel watchlist
  perRegionTrending?: number;                     // default 25
  perCategory?: number;                           // default 15
  perChannel?: number;                            // default 5
  minViews?: number;                              // default 100_000
  maxAgeDays?: number;                            // default 14 (fresh virals only)
  minDurationSec?: number;                        // default 10 * 60 (10 min — long enough to clip)
  maxDurationSec?: number;                        // default 4 * 60 * 60 (4 hr cap)
};

export type DiscoveredVideo = {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;      // ISO
  durationSec: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  categoryId: string;
  regionSource?: string;    // region that surfaced it in trending
  thumbnails?: Record<string, { url: string; width: number; height: number }>;
  /** Composite score (higher = more viral-worthy). Derived in rank(). */
  score?: number;
  /** Signal breakdown for the log. */
  signals?: Record<string, number>;
};

// ---------- API ----------

/** videos.list — fetch stats + content details for up to 50 ids. 1 unit/call. */
async function videosList(apiKey: string, ids: string[]): Promise<DiscoveredVideo[]> {
  if (!ids.length) return [];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  const out: DiscoveredVideo[] = [];
  for (const batch of batches) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${batch.join(",")}&key=${apiKey}`;
    const r = await fetchOk(url, { method: "GET" });
    const data = await r.json() as { items: Array<{
      id: string;
      snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string; categoryId: string; thumbnails?: Record<string, { url: string; width: number; height: number }> };
      statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
      contentDetails: { duration: string };
    }> };
    for (const it of data.items) {
      out.push({
        id: it.id,
        title: it.snippet.title,
        channelId: it.snippet.channelId,
        channelTitle: it.snippet.channelTitle,
        publishedAt: it.snippet.publishedAt,
        durationSec: parseIsoDuration(it.contentDetails.duration),
        viewCount: Number(it.statistics.viewCount ?? 0),
        likeCount: Number(it.statistics.likeCount ?? 0),
        commentCount: Number(it.statistics.commentCount ?? 0),
        categoryId: it.snippet.categoryId,
        thumbnails: it.snippet.thumbnails,
      });
    }
  }
  return out;
}

/** videos.list?chart=mostPopular — 1 unit/call. 50 max per call. */
async function trendingInRegion(apiKey: string, regionCode: string, max: number, categoryId?: string): Promise<DiscoveredVideo[]> {
  const parts = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    chart: "mostPopular",
    regionCode,
    maxResults: String(Math.min(50, max)),
    key: apiKey,
  });
  if (categoryId) parts.set("videoCategoryId", categoryId);
  // Direct fetch so we can read the full error body — fetchOk truncates to 800 chars which
  // cut off the actual Google error reason on past CI runs ("API key not valid", "referer blocked", etc.).
  const resp = await fetch(`https://www.googleapis.com/youtube/v3/videos?${parts}`, { method: "GET" });
  if (!resp.ok) {
    const text = (await resp.text()).replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`${resp.status}: ${text}`);
  }
  const r = resp;
  const data = await r.json() as { items: Array<{
    id: string;
    snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string; categoryId: string; thumbnails?: Record<string, { url: string; width: number; height: number }> };
    statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
    contentDetails: { duration: string };
  }> };
  return data.items.map((it) => ({
    id: it.id,
    title: it.snippet.title,
    channelId: it.snippet.channelId,
    channelTitle: it.snippet.channelTitle,
    publishedAt: it.snippet.publishedAt,
    durationSec: parseIsoDuration(it.contentDetails.duration),
    viewCount: Number(it.statistics.viewCount ?? 0),
    likeCount: Number(it.statistics.likeCount ?? 0),
    commentCount: Number(it.statistics.commentCount ?? 0),
    categoryId: it.snippet.categoryId,
    regionSource: regionCode,
    thumbnails: it.snippet.thumbnails,
  }));
}

/** search.list on a channel — 100 units/call. Use sparingly; prefer uploads playlist for cheap. */
async function channelLatest(apiKey: string, channelId: string, max: number): Promise<string[]> {
  const url = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&order=date&type=video&maxResults=${Math.min(50, max)}&key=${apiKey}`;
  const r = await fetchOk(url, { method: "GET" });
  const data = await r.json() as { items: Array<{ id: { videoId: string } }> };
  return data.items.map((it) => it.id.videoId);
}

// ---------- Rank + filter ----------

/** Parse ISO 8601 duration (PT1H23M45S) to seconds. */
function parseIsoDuration(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function daysSince(iso: string): number {
  return Math.max(0.1, (Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** Composite rank score. Higher = more viral-worthy for clipping:
 *    - views_per_day: fresh high-growth > old-but-stable
 *    - engagement:    (likes + 10*comments) / views, scaled
 *    - duration:      bonus if in the sweet 20-90 min interview/podcast band
 *    - category:      slight bonus for people&blogs (podcasts) — easiest to clip into coherent pieces
 */
export function rank(videos: DiscoveredVideo[]): DiscoveredVideo[] {
  return [...videos]
    .map((v) => {
      const vpd = v.viewCount / daysSince(v.publishedAt);
      const eng = v.viewCount > 0 ? ((v.likeCount + 10 * v.commentCount) / v.viewCount) * 1_000_000 : 0;
      const durBonus = v.durationSec >= 20 * 60 && v.durationSec <= 90 * 60 ? 1.0 : (v.durationSec >= 10 * 60 && v.durationSec <= 180 * 60 ? 0.5 : 0.2);
      const catBonus = v.categoryId === "22" ? 1.2 : 1.0;
      const signals = {
        views_per_day: Math.round(vpd),
        engagement_per_m: Math.round(eng),
        duration_min: Math.round(v.durationSec / 60),
      };
      // Compose: log-scaled vpd dominates, engagement is a tiebreaker.
      const score = (Math.log10(1 + vpd) * 10) * durBonus * catBonus + (eng / 100);
      return { ...v, score, signals };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Hard filters applied before ranking: duration band, min views, dedupe, blacklist. */
export async function filter(videos: DiscoveredVideo[], cfg: DiscoverConfig): Promise<DiscoveredVideo[]> {
  const minViews = cfg.minViews ?? 100_000;
  const maxAgeDays = cfg.maxAgeDays ?? 14;
  const minD = cfg.minDurationSec ?? 10 * 60;
  const maxD = cfg.maxDurationSec ?? 4 * 60 * 60;
  const seen = new Set<string>();
  const out: DiscoveredVideo[] = [];
  for (const v of videos) {
    if (seen.has(v.id)) continue;
    if (v.viewCount < minViews) continue;
    if (daysSince(v.publishedAt) > maxAgeDays) continue;
    if (v.durationSec < minD || v.durationSec > maxD) continue;
    if (await isReviewed(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

/** Main entry: run every source, union, filter, rank, return top N. */
export async function discover(cfg: DiscoverConfig, topN = 20): Promise<DiscoveredVideo[]> {
  const perRegion = cfg.perRegionTrending ?? 25;
  const perCat = cfg.perCategory ?? 15;
  const perCh = cfg.perChannel ?? 5;
  const bucket: DiscoveredVideo[] = [];

  for (const region of cfg.regionCodes) {
    try {
      const vs = await trendingInRegion(cfg.apiKey, region, perRegion);
      console.log(`[discover] trending[${region}]: ${vs.length}`);
      bucket.push(...vs);
    } catch (e) { console.warn(`[discover] trending[${region}] failed: ${(e as Error).message.split("\n")[0]}`); }

    for (const catId of cfg.categoryIds ?? []) {
      try {
        const vs = await trendingInRegion(cfg.apiKey, region, perCat, catId);
        console.log(`[discover] trending[${region},cat=${catId}]: ${vs.length}`);
        bucket.push(...vs);
      } catch (e) { console.warn(`[discover] trending[${region},cat=${catId}] failed: ${(e as Error).message.split("\n")[0]}`); }
    }
  }

  if (cfg.channelIds?.length) {
    const chIds: string[] = [];
    for (const chId of cfg.channelIds) {
      try {
        const ids = await channelLatest(cfg.apiKey, chId, perCh);
        chIds.push(...ids);
      } catch (e) { console.warn(`[discover] channel[${chId}] failed: ${(e as Error).message.split("\n")[0]}`); }
    }
    if (chIds.length) {
      const vs = await videosList(cfg.apiKey, chIds);
      console.log(`[discover] channels: ${vs.length}`);
      bucket.push(...vs);
    }
  }

  const filtered = await filter(bucket, cfg);
  const ranked = rank(filtered);
  console.log(`[discover] ${bucket.length} raw → ${filtered.length} after filter → top ${Math.min(topN, ranked.length)}`);
  return ranked.slice(0, topN);
}
