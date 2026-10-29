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
import { agentReachAvailable, mentionSignal } from "./agent-reach.js";
import { classifyNarrative, type NarrativeVerdict } from "./narrative-classifier.js";
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
  /** M13 — YouTube snippet language hints. Either/both may be present. We prefer defaultAudioLanguage
   *  (what the audience hears) over defaultLanguage (metadata locale). Used to hard-reject non-English
   *  videos at filter time, after the Gambian-Mandinka clip slipped through in trial #6. */
  defaultAudioLanguage?: string;
  defaultLanguage?: string;
  /** M14.2 — matched topic categories per the 10-category taxonomy. Populated in filter(). */
  topics?: TopicCategory[];
  /** Composite score (higher = more viral-worthy). Derived in rank(). */
  score?: number;
  /** M14.3 — 100-pt scaled score with named subscores, per spec D. Populated after enrich. */
  score100?: number;
  subscores?: {
    hook: number;              // 0-25
    suspense: number;          // 0-20
    clarity: number;           // 0-15
    payoff: number;            // 0-15
    vertical: number;          // 0-10
    trend: number;             // 0-10
    replay: number;            // 0-5
  };
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
      snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string; categoryId: string; defaultAudioLanguage?: string; defaultLanguage?: string; thumbnails?: Record<string, { url: string; width: number; height: number }> };
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
        defaultAudioLanguage: it.snippet.defaultAudioLanguage,
        defaultLanguage: it.snippet.defaultLanguage,
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
    snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string; categoryId: string; defaultAudioLanguage?: string; defaultLanguage?: string; thumbnails?: Record<string, { url: string; width: number; height: number }> };
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
    defaultAudioLanguage: it.snippet.defaultAudioLanguage,
    defaultLanguage: it.snippet.defaultLanguage,
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

/** M8.3 — fetch a channel's recent upload view counts for baseline comparison. 100 units for the
 *  search call + 1 for the videos.list. Cached per channel for the discover run (one call per
 *  channel per run, regardless of how many of their videos are candidates). */
const CHANNEL_BASELINE_CACHE = new Map<string, number>();
async function channelMedianViews(apiKey: string, channelId: string): Promise<number | null> {
  if (CHANNEL_BASELINE_CACHE.has(channelId)) return CHANNEL_BASELINE_CACHE.get(channelId)!;
  try {
    const ids = await channelLatest(apiKey, channelId, 10);
    if (ids.length < 3) { CHANNEL_BASELINE_CACHE.set(channelId, 0); return null; }
    const videos = await videosList(apiKey, ids);
    const views = videos.map((v) => v.viewCount).filter((n) => n > 0).sort((a, b) => a - b);
    if (!views.length) { CHANNEL_BASELINE_CACHE.set(channelId, 0); return null; }
    const median = views[Math.floor(views.length / 2)]!;
    CHANNEL_BASELINE_CACHE.set(channelId, median);
    return median;
  } catch (e) {
    console.warn(`[discover] channelMedianViews(${channelId}) failed: ${(e as Error).message.split("\n")[0]}`);
    CHANNEL_BASELINE_CACHE.set(channelId, 0);
    return null;
  }
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
      // M10.3 — refined category bonuses: Entertainment/Gaming/Comedy/Sports STRONGLY boosted;
      // News & Politics (25) heavily penalized unless a genre keyword rescues it.
      const baseCat = ({
        "24": 1.4,   // Entertainment (MrBeast, Mark Rober)
        "20": 1.3,   // Gaming (streamer clips, challenge games)
        "17": 1.3,   // Sports (Dude Perfect, trick shots)
        "23": 1.25,  // Comedy
        "22": 1.1,   // People & Blogs (podcasts/interviews, but can be lifestyle so smaller boost)
      } as Record<string, number>)[v.categoryId] ?? 1.0;
      const penalty = PENALIZED_CATEGORIES[v.categoryId] ?? 1.0;
      // A genre keyword in the title cancels most of a category penalty — a "challenge" video
      // in News (unlikely but possible) shouldn't be nuked.
      const catBonus = penalty < 1.0 && countGenreHits(v.title) > 0 ? Math.max(penalty, 0.85) : baseCat * penalty;
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
      // M7.1: creator allowlist + genre-keyword boosts. Explicitly spec'd creators
      // (MrBeast / Dude Perfect / etc.) multiply by CREATOR_BONUS. Challenge/experiment/stunt
      // keywords add flat points, capped so title-stuffing can't game it.
      const creatorBonus = CREATOR_ALLOWLIST.has(v.channelTitle.toLowerCase()) ? CREATOR_BONUS : 1.0;
      const genreHits = countGenreHits(v.title);
      const genrePoints = genreHits * GENRE_KEYWORD_POINTS;
      const signals = {
        views_per_day: Math.round(vpd),
        views_per_hour: Math.round(vph),
        engagement_per_m: Math.round(eng),
        like_view_pct: +likeView.toFixed(2),
        chapter_density_per_h: +chapterDensity.toFixed(2),
        duration_min: Math.round(v.durationSec / 60),
        hours_old: +hoursOld.toFixed(1),
        channel_penalized: failedChannels.has(v.channelTitle) ? 1 : 0,
        creator_allowlisted: creatorBonus > 1 ? 1 : 0,
        genre_keyword_hits: genreHits,
      };
      const score = (velocityScore + Math.log10(1 + vpd) * 5) * durBonus * catBonus * freshness * chapterBonus * outcomePenalty * creatorBonus
                  + (eng / 100)
                  + (likeView * 2)
                  + genrePoints;
      return { ...v, score, signals };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** M7.1 — creator allowlist. Channels explicitly called out as the target genre ("MrBeast, Dude
 *  Perfect, and other established creators known for high-view challenges, experiments,
 *  competitions, surprising moments, comedy, reactions, stunts, and entertaining storytelling"
 *  per the user's spec). Match on channelTitle lowercase. Any match multiplies the rank score
 *  by CREATOR_BONUS so these dominate the top of the picks list even when a smaller channel's
 *  velocity happens to be higher that hour. */
const CREATOR_ALLOWLIST = new Set<string>([
  "mrbeast",
  "beast reacts",
  "mrbeast gaming",
  "mrbeast 2",
  "dude perfect",
  "mark rober",
  "michelle khare",
  "ryan trahan",
  "airrack",
  "hangtime",
  "zach king",
  "danny gonzalez",
  "kurtis conner",
  "drew gooden",
  "jubilee",
  "ishowspeed",
  "kai cenat",
  "mrwhosetheboss",
  "linus tech tips",
  "veritasium",
  "mark angel comedy",
  "sidemen",
  "ksi",
  "miniminter",
  "logan paul",
  "jake paul",
  "nelk",
  "full send podcast",
  "jesser",
  "2hype",
  "typical gamer",
]);
const CREATOR_BONUS = 1.5;

/** M14.2 — strict 10-category topic taxonomy (per spec section A). Each category has its own
 *  keyword cluster. A candidate is ELIGIBLE only if its title/channel matches at least one
 *  category — otherwise it's rejected at filter time (even if it was trending in a region).
 *  This replaces M7.1's additive-only genre bonus with an eligibility gate PLUS a bonus.
 *  Order of listing matches the spec's taxonomy exactly so category tags remain readable in
 *  the candidate report. */
export const TOPIC_CATEGORIES = {
  // 1. Extreme challenges, competitions, survival tests, prize-based contests.
  // M14.5 — removed bare "challenge/challenged/challenging" because trial #8 matched a
  // 106-min worship livestream ("HALLELUJAH CHALLENGE") on it. Require a competitive /
  // numeric / prize framing instead.
  "challenges": [
    "100 vs ", "1 vs ", "vs 100", "vs 10", "players vs ", " vs. the",
    "last to leave", "last one standing", "first to ", "elimination",
    "survive", "surviving", "survived", "survival", "locked in",
    "tournament", "competition", "championship", "squid game", "beast games",
    "$10000", "$100000", "$1000000", "$1,000,000",
    "cheapest vs ", "most expensive", "$1 vs ", "prize", "winner takes",
    "mrbeast challenge", "beast challenge", "impossible challenge", "extreme challenge",
    "24 hour challenge", "24-hour challenge", "food challenge", "chubbyemu",
  ],
  // 2. Incredible skills, trick shots, stunts, records, satisfying achievements.
  "skills-stunts": [
    "trick shot", "trickshot", "no scope", "stunt", "stunts",
    "world record", "world's largest", "world's smallest", "world's longest",
    "worlds largest", "worlds smallest", "worlds longest",
    "impossible shot", "insane shot", "crazy shot", "first ever", "nobody has",
    "mastered", "perfect", "flawless", "satisfying",
  ],
  // 3. Unexpected experiments, mysteries, myth-busting, surprising discoveries.
  "experiments": [
    "i tried", "i tested", "i put", "i mixed", "i built", "i made", "i ate",
    "experiment", "experimenting", "myth", "mythbuster", "debunk",
    "what happens if", "what if", "we tested", "we tried",
    "secret", "mystery", "unexplained", "discovered",
  ],
  // 4. Funny interactions, entertaining reactions, unexpected social situations.
  "funny-reactions": [
    "reaction", "reacts to", "reacting to",
    "funny", "hilarious", "comedy", "prank", "pranks", "pranked",
    "awkward", "cringe", "roasted", "exposed on", "called out",
    "surprised", "surprise ", "shocked", "unexpected", "plot twist",
  ],
  // 5. Podcast moments: compelling stories, surprising insights, meaningful disagreements.
  "podcast-moments": [
    "podcast", "interview", "conversation with", "sat down with",
    "unfiltered", "candid", "told me", "revealed", "admits",
    "controversial opinion", "unpopular opinion", "hot take",
    "disagree", "debate", "argue", "pushed back",
  ],
  // 6. Sports highlights, dramatic comebacks, decisive moments, extraordinary performances.
  "sports-highlights": [
    "goal", "goals", "touchdown", "home run", "homerun", "slam dunk", "dunk",
    "comeback", "upset", "overtime", "walk-off", "walk off", "buzzer beater",
    "nba", "nfl", "fifa", "champions league", "super bowl", "world cup",
    "match-winning", "match winning", "highlight", "highlights", "final play",
  ],
  // 7. Transformations, restoration, before-and-after reveals, impressive builds.
  "transformations": [
    "transformation", "transforming", "transformed",
    "before and after", "before vs after", "makeover", "restore", "restored", "restoration",
    "renovation", "renovated", "built from scratch", "we built", "custom build",
    "reveal", "revealing", "revealed",
  ],
  // 8. Unusual facts, fascinating explanations, compelling demonstrations.
  "fascinating-explainers": [
    "did you know", "fun fact", "actually", "the truth about", "the real reason",
    "explained", "explains", "how it works", "how to", "why do", "why does", "why we",
    "fascinating", "unusual", "weirdest", "strangest",
    "inside", "behind the scenes", "behind-the-scenes",
  ],
  // 9. Business experiments, ambitious projects, entrepreneurial lessons, money stories.
  "business-money": [
    "startup", "entrepreneur", "founder", "built a business", "built my business",
    "i spent", "i gave", "i bought", "i invested", "i turned",
    "million dollar", "trillion", "billion dollar", "net worth",
    "business lesson", "biggest lesson", "biggest mistake", "how i made",
    "scam", "pyramid scheme", "exposed scam",
  ],
  // 10. Relationship stories, human-interest moments, emotional revelations.
  "human-interest": [
    "proposal", "proposed to", "wedding", "reunited", "reunion", "meeting",
    "adopted", "homeless", "rescued", "saving", "saved a",
    "tears", "crying", "emotional", "heartfelt", "heartbreaking", "touching",
    "stranger", "random act", "paid for", "surprise gift", "surprised my",
  ],
} as const satisfies Record<string, readonly string[]>;
export type TopicCategory = keyof typeof TOPIC_CATEGORIES;

const GENRE_KEYWORD_POINTS = 20;             // bonus per matched category
const GENRE_KEYWORD_CAP = 3;                 // at most 3 categories count toward the bonus

/** Classify a title into its matched categories. First-match ordering is the spec order; a
 *  title can match multiple categories (e.g. "I spent $1,000,000 on a challenge" = business
 *  + challenges). Empty array = NO match → eligibility gate rejects. */
export function classifyTopics(title: string, channel: string = ""): TopicCategory[] {
  const hay = (title + " || " + channel).toLowerCase();
  const matched: TopicCategory[] = [];
  for (const cat of Object.keys(TOPIC_CATEGORIES) as TopicCategory[]) {
    for (const kw of TOPIC_CATEGORIES[cat]) {
      if (hay.includes(kw)) { matched.push(cat); break; }
    }
  }
  return matched;
}

/** M10.3 — celebrity-gossip blocklist. Trial run #2 shipped Piers Morgan tabloid coverage of
 *  Thomas Markle because News & Politics (category 25) + viral news + no narrative classifier
 *  = top rank. These terms, in a title, flag celebrity-drama content. Rejected UNLESS the title
 *  also contains an explicit genre keyword (so e.g. a "100 celebrities in a challenge" video
 *  isn't blocked). */
const CELEBRITY_GOSSIP_TERMS = [
  "markle", "royal family", "royal", "duchess", "prince ", "princess ", "duke of",
  "allegations", "scandal", "scandalous", "exposed", "leaked", "cheating", "affair",
  "divorce", "feud", "slam", "slams", "clap back", "drags ", "dragged for",
  "shocking confession", "confesses", "comes clean", "breaks silence",
  "accuser", "accusers", "accused", "accusation",
  "piers morgan", "tucker carlson", "jimmy kimmel", "ellen degeneres",
  "kardashian", "jenner", "oprah", "diddy", "chrisley", "kanye", "ye ",
] as const;

/** M10.3 — categories where VIRAL ≠ CLIP-WORTHY. News & Politics (25) gets a strong penalty
 *  unless the title has a genre keyword. Film & Animation (1) same. Autos (2), Pets (15),
 *  Travel (19) get smaller penalties. */
const PENALIZED_CATEGORIES: Record<string, number> = {
  "25": 0.35,   // News & Politics
  "1":  0.5,    // Film & Animation (movie trailers, clips)
  "15": 0.7,    // Pets & Animals
  "2":  0.7,    // Autos & Vehicles
  "19": 0.8,    // Travel & Events
};

/** M14.2 — count DISTINCT matched topic categories in a title, capped at GENRE_KEYWORD_CAP.
 *  This replaces M7.1's raw keyword-hit count: a stuffed title ("CHALLENGE EXPERIMENT STUNT")
 *  across 3 categories still only hits the cap. */
function countGenreHits(title: string, channel: string = ""): number {
  return Math.min(GENRE_KEYWORD_CAP, classifyTopics(title, channel).length);
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

/** M13 — English-only gate. Trial #6 shipped a Mandinka-language Gambian film because the narrative
 *  classifier failed on quota and no language check ran. Two checks:
 *   1) YouTube's own snippet.defaultAudioLanguage / defaultLanguage. "en", "en-US", "en-GB" pass.
 *      Any other explicit tag (hi, ta, ur, bn, es, pt, fr, ar, zh, …) rejects. Field is often absent;
 *      a missing field alone does NOT reject — we fall through to script detection.
 *   2) Title script fingerprint. If a title's non-space characters are >=40% in a non-Latin script
 *      (Devanagari, Tamil, Bengali, Telugu, Gurmukhi, Malayalam, Kannada, Gujarati, Odia,
 *      Arabic/Persian, Hebrew, Thai, CJK Han/Hangul/Hiragana/Katakana, Cyrillic, Greek), reject.
 *      Latin + emoji + punctuation + a few romanised foreign words still pass. The threshold is
 *      generous because MrBeast titles sometimes have one Hindi/Mandarin word for a thumbnail hook.
 */
const NON_LATIN_SCRIPT_RE = /[Ѐ-ӿͰ-Ͽ֐-׿؀-ۿݐ-ݿऀ-ॿঀ-৿਀-੿઀-૿଀-୿஀-௿ఀ-౿ಀ-೿ഀ-ൿ฀-๿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯]/g;
const NON_LATIN_SCRIPT_REJECT_RATIO = 0.40;

/** Returns a reason string if the video is NOT English, or null if it passes. */
function matchesNonEnglish(v: DiscoveredVideo): string | null {
  // 1) Explicit language tag — authoritative when present.
  const langs = [v.defaultAudioLanguage, v.defaultLanguage].filter((x): x is string => !!x);
  for (const lang of langs) {
    const code = lang.toLowerCase().split("-")[0];
    if (code && code !== "en") return `lang=${lang}`;
  }
  // 2) Title script fingerprint — catches videos with no language tag.
  const titleNoSpace = v.title.replace(/\s+/g, "");
  if (titleNoSpace.length === 0) return null;
  const nonLatinMatches = titleNoSpace.match(NON_LATIN_SCRIPT_RE);
  const nonLatinChars = nonLatinMatches ? nonLatinMatches.length : 0;
  const ratio = nonLatinChars / titleNoSpace.length;
  if (ratio >= NON_LATIN_SCRIPT_REJECT_RATIO) return `non-latin-script-ratio=${ratio.toFixed(2)}`;
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
  let blockedByGossip = 0;
  let blockedByLanguage = 0;
  let blockedByTopic = 0;
  for (const v of videos) {
    if (seen.has(v.id)) continue;
    if (v.viewCount < minViews) continue;
    if (daysSince(v.publishedAt) > maxAgeDays) continue;
    if (v.durationSec < minD || v.durationSec > maxD) continue;
    if (await isReviewed(v.id)) continue;
    // M13 — English-only gate. Checked BEFORE lifestyle/gossip so stats are accurate.
    const nonEn = matchesNonEnglish(v);
    if (nonEn) { blockedByLanguage++; continue; }
    const match = matchesLifestyleBlocklist(v.title, v.channelTitle);
    if (match) { blockedByLifestyle++; continue; }
    // M14.2 — STRICT topic taxonomy gate. A candidate must match at least one of the 10
    // categories by title or channel keyword. "I'm just a guy filming his cat" is viral-shaped
    // but doesn't fit the taxonomy and gets dropped. An allowlist creator skips this gate —
    // their uploads implicitly define their category, and the narrative classifier will catch
    // filler at the next stage. News/politics category (25) ALSO skips this gate because the
    // category itself qualifies as journalism-type content (penalty applies elsewhere).
    const inAllowlist = CREATOR_ALLOWLIST.has(v.channelTitle.toLowerCase());
    const topics = classifyTopics(v.title, v.channelTitle);
    if (!topics.length && !inAllowlist) { blockedByTopic++; continue; }
    v.topics = topics;
    // M10.3 — celebrity-gossip gate. Reject if ANY gossip term matches AND no genre keyword
    // rescues it. ("100 celebrities VS Mr. Beast" is a challenge; "Markle allegations" is gossip.)
    const hay = (v.title + " || " + v.channelTitle).toLowerCase();
    const hasGossipTerm = CELEBRITY_GOSSIP_TERMS.some((t) => hay.includes(t));
    const hasGenreKeyword = countGenreHits(v.title) > 0;
    if (hasGossipTerm && !hasGenreKeyword) { blockedByGossip++; continue; }
    seen.add(v.id);
    out.push(v);
  }
  if (blockedByLanguage) console.log(`[discover] rejected ${blockedByLanguage} non-English videos (lang tag or non-latin script)`);
  if (blockedByLifestyle) console.log(`[discover] rejected ${blockedByLifestyle} lifestyle/vlog videos (title/channel match)`);
  if (blockedByGossip) console.log(`[discover] rejected ${blockedByGossip} celebrity-gossip videos (gossip term, no genre keyword)`);
  if (blockedByTopic) console.log(`[discover] rejected ${blockedByTopic} videos outside the 10-category taxonomy (M14.2 strict topic gate)`);
  return out;
}

/** M7.3 — enrich the top-K candidates with cross-platform mention counts from Agent-Reach
 *  (Reddit + web). Adds a `cross_platform_hits` signal and boosts score by log10(1 + hits) * 12.
 *  Quota-aware: only enriches top MENTION_ENRICH_TOP picks (default 5) so we don't blow
 *  discover-job runtime hitting Reddit for every one of 200 raw candidates. Falls back silently
 *  if agent-reach is not on PATH. */
const MENTION_ENRICH_TOP = 5;
const MENTION_SCORE_WEIGHT = 12;              // log10(1 + hits) * this → added to score
const BASELINE_MULTIPLE_WEIGHT = 8;           // log2(multiple) * this → added to score

async function enrichWithMentions(ranked: DiscoveredVideo[]): Promise<DiscoveredVideo[]> {
  if (!(await agentReachAvailable())) {
    console.log(`[discover] agent-reach not on PATH; skipping cross-platform enrichment`);
    return ranked;
  }
  const topK = ranked.slice(0, MENTION_ENRICH_TOP);
  console.log(`[discover] enriching top ${topK.length} with Agent-Reach mentions...`);
  for (const v of topK) {
    try {
      const sig = await mentionSignal(v.title, v.channelTitle);
      const boost = Math.log10(1 + sig.totalHits) * MENTION_SCORE_WEIGHT;
      v.score = (v.score ?? 0) + boost;
      v.signals = { ...(v.signals ?? {}), cross_platform_hits: sig.totalHits, mention_boost: +boost.toFixed(1) };
      console.log(`  ${v.id} "${v.title.slice(0, 50)}" → reddit=${sig.reddit.hits}${sig.reddit.skipped ? "(skip:" + sig.reddit.skipped + ")" : ""} web=${sig.web.hits}${sig.web.skipped ? "(skip:" + sig.web.skipped + ")" : ""} +${boost.toFixed(1)}pts`);
    } catch (e) {
      console.warn(`  ${v.id} mention-enrich failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  // Re-sort because the boosts may have reshuffled the top.
  return [...ranked].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** M8.3 — channel-baseline multiple. For each top-K candidate, fetch the channel's recent-upload
 *  median views and compute multiple = thisVideoViews / medianViews. A value >1 means the video
 *  is overperforming its channel's own baseline — the "smaller channel with a breakout video" the
 *  spec explicitly asks us to prefer over "old video with millions of accumulated views". Boost
 *  score by log2(multiple) * BASELINE_MULTIPLE_WEIGHT. Null baseline → score unchanged
 *  (signal="unavailable", per spec rule "mark unavailable rather than invent"). */
async function enrichWithBaseline(ranked: DiscoveredVideo[], apiKey: string, k = MENTION_ENRICH_TOP): Promise<DiscoveredVideo[]> {
  const topK = ranked.slice(0, k);
  console.log(`[discover] computing channel baselines for top ${topK.length}...`);
  for (const v of topK) {
    const median = await channelMedianViews(apiKey, v.channelId);
    if (median === null || median <= 0) {
      v.signals = { ...(v.signals ?? {}), baseline_median_views: 0, baseline_multiple: 0, baseline_status: 1 /* 1=unavailable */ };
      continue;
    }
    const multiple = v.viewCount / median;
    const boost = multiple > 1 ? Math.log2(multiple) * BASELINE_MULTIPLE_WEIGHT : -Math.log2(1 / Math.max(0.1, multiple)) * BASELINE_MULTIPLE_WEIGHT / 2;
    v.score = (v.score ?? 0) + boost;
    v.signals = { ...(v.signals ?? {}), baseline_median_views: median, baseline_multiple: +multiple.toFixed(2), baseline_boost: +boost.toFixed(1) };
    console.log(`  ${v.id} baseline median=${median.toLocaleString()}, multiple=${multiple.toFixed(2)}x, +${boost.toFixed(1)}pts`);
  }
  return [...ranked].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
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
  // M8.3: channel-baseline multiple first (spec section 3: "prioritize exceptional performance
  // relative to comparable videos") — this rewrites scores for the head.
  const withBaseline = await enrichWithBaseline(ranked.slice(0, Math.max(topN, MENTION_ENRICH_TOP)), cfg.apiKey);
  // M7.3: Agent-Reach cross-platform mention counts on top of that.
  const enriched = await enrichWithMentions(withBaseline);
  // M8.2: LLM narrative-type classifier on the top-K. Rejects "filler" verdicts outright, boosts
  // high viralRating. Null (LLM unavailable) → signal marked "unavailable" and score unchanged.
  const classified = await enrichWithNarrative(enriched);
  // M14.3 — compute the 100-pt scaled score with named subscores on every surviving candidate.
  for (const v of classified) attachScore100(v);
  return classified.slice(0, topN);
}

/** M14.3 — 100-point composite score per spec D (hook 25 / suspense 20 / clarity 15 / payoff 15 /
 *  vertical 10 / trend 10 / replay 5). Each sub-component is derived from existing signals so
 *  it's reproducible and the breakdown is readable in the candidate report. Signals that are
 *  genuinely unavailable (null narrative, no baseline) get 0 — NOT fabricated — per spec rule.
 *
 *  The underlying scalar `score` (used for sorting) is kept as-is: it mixes dozens of channel/
 *  category/velocity factors tuned over M3-M12. This routine OVERLAYS the readable 7-dimension
 *  view that the candidate report + the user's spec expects. */
function attachScore100(v: DiscoveredVideo): void {
  const s = v.signals ?? {};
  // Narrative-classifier subscores are 0-10. Rescale to the spec's weights.
  const nHook = (s["narrative_hook"] ?? 0) / 10;             // 0..1
  const nNovelty = (s["narrative_novelty"] ?? 0) / 10;
  const nPayoff = (s["narrative_payoff"] ?? 0) / 10;
  const nClarity = (s["narrative_clarity"] ?? 0) / 10;
  const nEmotion = (s["narrative_hook"] ?? s["narrative_novelty"] ?? 0) / 10;
  const nViral = (s["narrative_viral"] ?? 0) / 100;          // 0..1
  // Trend = baseline multiple + cross-platform mentions, each 0..1 then averaged.
  const trendBaseline = Math.min(1, Math.max(0, Math.log2(Math.max(0.25, s["baseline_multiple"] ?? 1)) / 2));
  const trendMentions = Math.min(1, Math.log10(1 + (s["cross_platform_hits"] ?? 0)) / 2);
  const trendBlend = (trendBaseline + trendMentions) / 2;
  // Vertical difficulty — we don't have the final crop verdict yet (it runs post-extract on
  // the actual pixels). Approximate: category 10 (Music), 17 (Sports), 20 (Gaming) are high-
  // motion / vertical-friendly; 25 (News) is talking-head and typically mid; defaults to 0.7.
  const verticalByCat: Record<string, number> = { "10": 0.9, "17": 0.9, "20": 0.9, "24": 0.85, "23": 0.85, "22": 0.7, "25": 0.6 };
  const vertEase = verticalByCat[v.categoryId] ?? 0.7;
  // Replay potential — tied to novelty + emotional intensity (high-novelty + high-emotion
  // moments get re-watched). Signals from the narrative classifier.
  const replay = (nNovelty + nEmotion) / 2;
  const hook = Math.round(nHook * 25);
  const suspense = Math.round(((nNovelty + nViral) / 2) * 20);
  const clarity = Math.round(nClarity * 15);
  const payoff = Math.round(nPayoff * 15);
  const vertical = Math.round(vertEase * 10);
  const trend = Math.round(trendBlend * 10);
  const replayPts = Math.round(replay * 5);
  v.subscores = { hook, suspense, clarity, payoff, vertical, trend, replay: replayPts };
  v.score100 = hook + suspense + clarity + payoff + vertical + trend + replayPts;
}

/** M14.3 — write a human-readable candidate report to disk (markdown) alongside the structured
 *  JSON the plan job already consumes. Called from scripts/clip-discover.ts. */
export async function writeCandidateReport(
  videos: DiscoveredVideo[],
  outPath: string,
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(outPath), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Candidate Report — ${today}`);
  lines.push(``);
  lines.push(`${videos.length} candidates ranked. Only those with score ≥ eligibility threshold reach the plan stage.`);
  lines.push(``);
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i]!;
    const s = v.subscores;
    const sig = v.signals ?? {};
    lines.push(`## ${i + 1}. ${v.title}`);
    lines.push(``);
    lines.push(`- **Creator**: ${v.channelTitle}`);
    lines.push(`- **URL**: https://www.youtube.com/watch?v=${v.id}`);
    lines.push(`- **Published**: ${v.publishedAt.slice(0, 10)} · **Duration**: ${(v.durationSec / 60).toFixed(1)}min · **Views**: ${v.viewCount.toLocaleString()}`);
    lines.push(`- **Category** (YT): ${v.categoryId} · **Topics** (M14): ${(v.topics ?? []).join(", ") || "allowlist-only"}`);
    lines.push(`- **Score (0-100)**: ${v.score100 ?? "n/a"} ${s ? `= hook ${s.hook}/25 + suspense ${s.suspense}/20 + clarity ${s.clarity}/15 + payoff ${s.payoff}/15 + vertical ${s.vertical}/10 + trend ${s.trend}/10 + replay ${s.replay}/5` : ""}`);
    lines.push(`- **Composite internal score** (sort key): ${(v.score ?? 0).toFixed(1)}`);
    if (sig["baseline_multiple"]) lines.push(`- **Baseline multiple**: ${(sig["baseline_multiple"]).toFixed(2)}× channel median`);
    if (sig["cross_platform_hits"]) lines.push(`- **Cross-platform mentions**: ${sig["cross_platform_hits"]} (Reddit + web)`);
    if (sig["narrative_viral"] !== undefined) lines.push(`- **Narrative viral rating** (classifier): ${sig["narrative_viral"]}/100`);
    if (sig["narrative_topicality"] !== undefined) lines.push(`- **Topicality** (today-vs-published): ${sig["narrative_topicality"]}/10`);
    const defAudio = v.defaultAudioLanguage ?? "–";
    lines.push(`- **Language**: audio=${defAudio} · meta=${v.defaultLanguage ?? "–"}`);
    lines.push(``);
  }
  await writeFile(outPath, lines.join("\n"), "utf8");
  // Mirror a JSON file so downstream tools don't have to parse markdown.
  const jsonPath = outPath.replace(/\.md$/, ".json");
  await writeFile(jsonPath, JSON.stringify(videos.map((v) => ({
    id: v.id, title: v.title, channel: v.channelTitle,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    publishedAt: v.publishedAt, durationSec: v.durationSec, viewCount: v.viewCount,
    categoryId: v.categoryId, topics: v.topics ?? [],
    score100: v.score100, subscores: v.subscores, score: v.score,
    signals: v.signals,
    defaultAudioLanguage: v.defaultAudioLanguage, defaultLanguage: v.defaultLanguage,
  })), null, 2), "utf8");
}

/** M8.2 — LLM narrative classifier for top candidates. Spec section 4 scoring: hook / novelty /
 *  payoff / standalone-clarity / emotional-intensity. Hard-rejects "filler" type (daily vlog,
 *  GRWM, decor tour) regardless of channel size. Rewrites scores for the head. Null verdict →
 *  signal marked unavailable (NEVER fabricated) and score unchanged. */
const NARRATIVE_CLASSIFIER_TOP = 5;
const NARRATIVE_SCORE_WEIGHT = 0.6;           // viralRating * this (so 100 → +60 pts)

async function enrichWithNarrative(ranked: DiscoveredVideo[]): Promise<DiscoveredVideo[]> {
  const topK = ranked.slice(0, NARRATIVE_CLASSIFIER_TOP);
  console.log(`[discover] narrative-classifying top ${topK.length}...`);
  const kept: DiscoveredVideo[] = [...ranked];
  for (const v of topK) {
    const verdict = await classifyNarrative({
      title: v.title,
      channel: v.channelTitle,
      description: "",                        // description not fetched in M3 — a future pass can add it
      durationSec: v.durationSec,
      viewCount: v.viewCount,
      publishedAt: v.publishedAt,             // M12.2 — pass publish date so classifier can judge topicality
    });
    if (!verdict) {
      v.signals = { ...(v.signals ?? {}), narrative_status: 1 /* unavailable */ };
      continue;
    }
    // signals is Record<string,number> by convention; encode the type label as a stable index.
    const typeIndex = ["filler", "challenge", "experiment", "competition", "reaction", "skill-demo", "storytelling", "reveal", "comedy", "stunt"].indexOf(verdict.type);
    v.signals = {
      ...(v.signals ?? {}),
      narrative_type_idx: typeIndex,
      narrative_hook: verdict.hookStrength,
      narrative_novelty: verdict.novelty,
      narrative_payoff: verdict.payoff,
      narrative_clarity: verdict.standaloneClarity,
      narrative_topicality: verdict.topicality,
      narrative_viral: verdict.viralRating,
      narrative_should_clip: verdict.shouldClip ? 1 : 0,
    };
    // M11.1 — HARD narrative gate. Reject if filler OR shouldClip=false OR viralRating<40.
    // viralRating=40 is "below average" per the Mistral rubric; anything less and the clip is
    // likely non-viral regardless of channel size. Only applies when classifier returned a
    // verdict — null = signal unavailable, score unchanged.
    const VIRAL_FLOOR = 40;
    if (verdict.type === "filler" || !verdict.shouldClip || verdict.viralRating < VIRAL_FLOOR) {
      v.score = -1;                           // sorts to the bottom and gets filtered out below
      console.log(`  ${v.id} "${v.title.slice(0, 60)}" → type=${verdict.type} viral=${verdict.viralRating} REJECTED: ${verdict.rationale.slice(0, 80)}`);
      continue;
    }
    const boost = verdict.viralRating * NARRATIVE_SCORE_WEIGHT;
    v.score = (v.score ?? 0) + boost;
    console.log(`  ${v.id} "${v.title.slice(0, 60)}" → type=${verdict.type} viral=${verdict.viralRating} +${boost.toFixed(1)}pts (${verdict.rationale.slice(0, 60)})`);
  }
  return [...kept].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).filter((v) => (v.score ?? 0) > -1);
}
