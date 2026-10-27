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
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUTCOMES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "clipper", "outcomes.json");

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
  /** M5: velocity-based discovery. When set, call search.list?order=viewCount&publishedAfter per
   *  region to find "hot new" videos (velocity signal). The default (48h) catches MrBeast-style
   *  overnight viral drops. */
  velocityHours?: number;                         // default 48
  velocityPerQuery?: number;                      // default 25
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

/** M5 — velocity-based discovery. search.list?order=viewCount&publishedAfter=<N hours ago> per
 *  region finds videos that got the most views in the recent window. Caught MrBeast / Dude Perfect
 *  overnight explosions on the first test. 100 units/call. */
async function searchByVelocity(apiKey: string, regionCode: string, hoursBack: number, max: number): Promise<string[]> {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  const url = `https://www.googleapis.com/youtube/v3/search?part=id&order=viewCount&publishedAfter=${since}&type=video&regionCode=${regionCode}&maxResults=${Math.min(50, max)}&videoDuration=long&relevanceLanguage=en&key=${apiKey}`;
  const r = await fetchOk(url, { method: "GET" });
  const data = await r.json() as { items?: Array<{ id?: { videoId?: string } }> };
  return (data.items ?? []).map((it) => it.id?.videoId).filter((x): x is string => !!x);
}

/** Load videoIds that previously FAILED gates. Used to penalize channels of underperformers. */
async function loadFailedChannels(): Promise<Set<string>> {
  if (!existsSync(OUTCOMES_FILE)) return new Set();
  try {
    const raw = JSON.parse(await readFile(OUTCOMES_FILE, "utf8")) as { records?: Array<{ kind: string; context?: { sourceChannel?: string; sourceVideoId?: string } }> };
    const out = new Set<string>();
    const failed = new Map<string, number>();
    for (const r of raw.records ?? []) {
      if (r.kind === "rejected" || r.kind === "dropped") {
        const ch = r.context?.sourceChannel;
        if (ch) failed.set(ch, (failed.get(ch) ?? 0) + 1);
      }
    }
    // A channel is penalized if ≥3 clips from it dropped. One-offs are noise.
    for (const [ch, n] of failed) if (n >= 3) out.add(ch);
    return out;
  } catch { return new Set(); }
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

/** Composite rank score. Higher = more clippability-worthy, not just view-count-worthy.
 *
 *  The 10 reference clips the user flagged (BBC children interrupt, Elon on Rogan, Lewin dotted
 *  lines, Chipmunk, Charlie bit my finger, XQC/Asmongold reactions, streamer scared, Speed's
 *  Ronaldo, Kai Cenat + Kevin Hart) all share: a long original (podcast / stream / lecture / live),
 *  high engagement (viewer reactions in comments), and either chaptered structure or a known-
 *  peak moment. We encode those as signals.
 *
 *    - views_per_day:   fresh high-growth > old-but-stable
 *    - engagement:      (likes + 10*comments) / views, in per-million
 *    - like_view:       likes / views — specifically rewards polarizing/memorable moments
 *    - chapter_density: chapters per hour — segmented structure means natural clip boundaries
 *    - duration bonus:  sweet band 20-90 min (interview/podcast length)
 *    - category bonus:  People & Blogs (podcasts), Gaming (streams), Entertainment all boosted
 *    - freshness:       the newer the better (within our 14-day cap)
 */
export function rank(videos: DiscoveredVideo[], chaptersById: Record<string, number> = {}, failedChannels: Set<string> = new Set()): DiscoveredVideo[] {
  return [...videos]
    .map((v) => {
      const days = daysSince(v.publishedAt);
      const hoursOld = Math.max(0.1, days * 24);
      const vpd = v.viewCount / days;
      const vph = v.viewCount / hoursOld;                              // M5: velocity (views/hr)
      const eng = v.viewCount > 0 ? ((v.likeCount + 10 * v.commentCount) / v.viewCount) * 1_000_000 : 0;
      const likeView = v.viewCount > 0 ? (v.likeCount / v.viewCount) * 100 : 0;
      const chapters = chaptersById[v.id] ?? 0;
      const chapterDensity = v.durationSec > 0 ? (chapters / (v.durationSec / 3600)) : 0;
      const durBonus = v.durationSec >= 20 * 60 && v.durationSec <= 90 * 60 ? 1.2 : (v.durationSec >= 10 * 60 && v.durationSec <= 180 * 60 ? 0.6 : 0.2);
      const catBonus = ({ "22": 1.3, "20": 1.2, "24": 1.15 } as Record<string, number>)[v.categoryId] ?? 1.0;
      const freshness = Math.max(0.3, 1 - (days / 30));
      const chapterBonus = chapterDensity >= 3 ? 1.2 : (chapterDensity >= 1 ? 1.05 : 1.0);
      // M5: velocity bonus — the dominant signal for "hot right now". A 1M-view video 6h old
      // (vph=166k) should outrank a 1M-view video 2 days old (vph=21k), per user's "MrBeast
      // overnight viral" criterion.
      const velocityScore = Math.log10(1 + vph) * 15;
      // M5: outcome-informed penalty. Channels whose clips have failed ≥3 times are tagged in
      // outcomes.json; penalize them without excluding entirely (one of their videos might still
      // be clippable; just rank lower).
      const outcomePenalty = failedChannels.has(v.channelTitle) ? 0.4 : 1.0;
      const signals = {
        views_per_day: Math.round(vpd),
        views_per_hour: Math.round(vph),
        engagement_per_m: Math.round(eng),
        like_view_pct: +likeView.toFixed(2),
        chapter_density_per_h: +chapterDensity.toFixed(2),
        duration_min: Math.round(v.durationSec / 60),
        hours_old: +hoursOld.toFixed(1),
        channel_penalized: failedChannels.has(v.channelTitle) ? 1 : 0,
      };
      const score = (velocityScore + Math.log10(1 + vpd) * 5) * durBonus * catBonus * freshness * chapterBonus * outcomePenalty
                  + (eng / 100)
                  + (likeView * 2);
      return { ...v, score, signals };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** M6.2 — lifestyle/vlog blocklist. The M4 run shipped three clips of a French chateau daily-vlog
 *  (title cards, wall decor, sliced faces). None of these are "challenge/skill/reveal/surprise".
 *  We hard-reject videos whose title or channel name matches these patterns, case-insensitively.
 *  Not every match is bad (a cooking channel does "chateau life" sometimes), but the user's rule
 *  was explicit: no daily routines, no ordinary person's day. */
const LIFESTYLE_BLOCKLIST = [
  // Routine / vlog phrases
  "day in my life", "day in the life", "a day with", "morning routine", "night routine",
  "evening routine", "weekly vlog", "daily vlog", "my routine", "my day", "my week",
  // Lifestyle framings
  "chateau life", "chateau diary", "chateau diaries", "my chateau", "cottage life",
  "farm life", "homestead", "slow living", "cozy", "aesthetic morning", "grwm",
  "get ready with me", "haul", "unboxing my", "what i eat in a day",
  "what i wore", "shop with me", "clean with me", "cook with me", "come with me",
  "self care sunday", "sunday reset", "weekend reset",
  // French equivalents (clip 1 was French)
  "ma journée", "ma semaine", "ma vie", "chez moi", "ma routine",
  "une journée", "vlog quotidien", "notre maison",
] as const;

/** Returns the first blocklist term the title/channel matched, or null. */
function matchesLifestyleBlocklist(title: string, channel: string): string | null {
  const hay = (title + " || " + channel).toLowerCase();
  for (const term of LIFESTYLE_BLOCKLIST) if (hay.includes(term)) return term;
  return null;
}

/** Hard filters applied before ranking: duration band, min views, dedupe, blacklist, lifestyle. */
export async function filter(videos: DiscoveredVideo[], cfg: DiscoverConfig): Promise<DiscoveredVideo[]> {
  const minViews = cfg.minViews ?? 100_000;
  const maxAgeDays = cfg.maxAgeDays ?? 14;
  const minD = cfg.minDurationSec ?? 10 * 60;
  const maxD = cfg.maxDurationSec ?? 4 * 60 * 60;
  const seen = new Set<string>();
  const out: DiscoveredVideo[] = [];
  let blockedByLifestyle = 0;
  for (const v of videos) {
    if (seen.has(v.id)) continue;
    if (v.viewCount < minViews) continue;
    if (daysSince(v.publishedAt) > maxAgeDays) continue;
    if (v.durationSec < minD || v.durationSec > maxD) continue;
    if (await isReviewed(v.id)) continue;
    const match = matchesLifestyleBlocklist(v.title, v.channelTitle);
    if (match) { blockedByLifestyle++; continue; }
    seen.add(v.id);
    out.push(v);
  }
  if (blockedByLifestyle) console.log(`[discover] rejected ${blockedByLifestyle} lifestyle/vlog videos (title/channel match)`);
  return out;
}

/** Main entry: run every source, union, filter, rank, return top N. */
export async function discover(cfg: DiscoverConfig, topN = 20): Promise<DiscoveredVideo[]> {
  const perRegion = cfg.perRegionTrending ?? 25;
  const perCat = cfg.perCategory ?? 15;
  const perCh = cfg.perChannel ?? 5;
  const velocityHours = cfg.velocityHours ?? 48;
  const velocityPer = cfg.velocityPerQuery ?? 25;
  const bucket: DiscoveredVideo[] = [];

  for (const region of cfg.regionCodes) {
    try {
      const vs = await trendingInRegion(cfg.apiKey, region, perRegion);
      console.log(`[discover] trending[${region}]: ${vs.length}`);
      bucket.push(...vs);
    } catch (e) { console.warn(`[discover] trending[${region}] failed: ${(e as Error).message.split("\n")[0]}`); }

    // M5: velocity-based search — "hot new" in last N hours. 100 units per region per call;
    // only run on explicit regions, not per-category (quota).
    try {
      const velIds = await searchByVelocity(cfg.apiKey, region, velocityHours, velocityPer);
      if (velIds.length) {
        const vs = await videosList(cfg.apiKey, velIds);
        console.log(`[discover] velocity[${region}, ${velocityHours}h]: ${vs.length}`);
        bucket.push(...vs.map((v) => ({ ...v, regionSource: region })));
      }
    } catch (e) { console.warn(`[discover] velocity[${region}] failed: ${(e as Error).message.split("\n")[0]}`); }

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

  const failedChannels = await loadFailedChannels();
  if (failedChannels.size) console.log(`[discover] penalizing ${failedChannels.size} previously-failing channels: ${[...failedChannels].slice(0, 5).join(", ")}${failedChannels.size > 5 ? "…" : ""}`);
  const filtered = await filter(bucket, cfg);
  const ranked = rank(filtered, {}, failedChannels);
  console.log(`[discover] ${bucket.length} raw → ${filtered.length} after filter → top ${Math.min(topN, ranked.length)}`);
  return ranked.slice(0, topN);
}
