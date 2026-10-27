/**
 * Clipper M7 — Agent-Reach wrapper. Panniantong/Agent-Reach is a Python CLI router over per-
 * platform tools (yt-dlp, xreach for Twitter, gh, mcporter for Xiaohongshu, Jina Reader for web).
 * We use it as a cross-platform MENTION-COUNT signal for the ranker: a YT video getting discussed
 * on Reddit + web is a stronger "viral" indicator than its view count alone.
 *
 * CI reality:
 *   - Reddit: usable without login per README
 *   - Web search (Jina Reader): usable without a key
 *   - YouTube: usable (we already use yt-dlp directly)
 *   - Twitter/X, Xiaohongshu, LinkedIn, Boss, Bilibili: need cookies/login; not viable on headless CI
 *
 * So this module ONLY queries Reddit + web search. Other channels are stubbed out and documented.
 *
 * Install (CI): see clip-pipeline.yml discover job. Falls back gracefully — if `agent-reach` is
 * not on PATH, this module returns zero mentions and logs a warning instead of failing the build.
 */
import { spawn } from "node:child_process";

export type MentionCount = {
  platform: "reddit" | "web" | "youtube";
  query: string;
  hits: number;
  sampleTitles: string[];     // up to 5 for the log
  skipped?: string;           // "cli-not-installed" | "channel-auth-required" | "timeout" | "error:..."
};

const MAX_SAMPLES = 5;
const QUERY_TIMEOUT_MS = 20_000;        // per-platform cap — don't hang the discover job

/** Fire `agent-reach <platform> <action> ...` and capture stdout. Returns null if the CLI is
 *  not installed or exits non-zero, so callers can degrade gracefully. */
async function runAgentReach(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn("agent-reach", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { p.kill("SIGTERM"); } catch { /* already dead */ } }, QUERY_TIMEOUT_MS);
    p.stdout.on("data", (c) => (stdout += c.toString()));
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT = CLI not installed. Not an error, just means degrade.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
      resolve(null);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      resolve(stdout);
    });
  });
}

/** Try to parse Agent-Reach output as JSON. Different channels emit different shapes; we assume
 *  the common shape {results: [{title, url, ...}]} or {items: [...]} and gracefully fall back to
 *  counting lines that look like URLs if parsing fails. */
function parseHits(stdout: string): { count: number; titles: string[] } {
  try {
    const obj = JSON.parse(stdout);
    const list = (obj.results ?? obj.items ?? obj.data ?? obj.hits ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(list)) {
      return {
        count: list.length,
        titles: list.slice(0, MAX_SAMPLES).map((r) => String(r.title ?? r.text ?? r.name ?? r.url ?? "")).filter(Boolean),
      };
    }
  } catch { /* not JSON, fall through */ }
  // Fallback: count URL-looking lines
  const urls = stdout.split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l));
  return { count: urls.length, titles: urls.slice(0, MAX_SAMPLES) };
}

/** Reddit mention count for a query (video title or "<creator> <title>"). */
export async function redditMentions(query: string): Promise<MentionCount> {
  const stdout = await runAgentReach(["reddit", "search", query, "--json"]);
  if (stdout === null) return { platform: "reddit", query, hits: 0, sampleTitles: [], skipped: "cli-not-installed" };
  const { count, titles } = parseHits(stdout);
  return { platform: "reddit", query, hits: count, sampleTitles: titles };
}

/** Web search via Agent-Reach's `web search` (Jina Reader backend). Counts non-YouTube results so
 *  we don't double-count the source video's own entry. */
export async function webMentions(query: string): Promise<MentionCount> {
  const stdout = await runAgentReach(["web", "search", query, "--json"]);
  if (stdout === null) return { platform: "web", query, hits: 0, sampleTitles: [], skipped: "cli-not-installed" };
  const { count, titles } = parseHits(stdout);
  const nonYtTitles = titles.filter((t) => !/youtube\.com|youtu\.be/i.test(t));
  return { platform: "web", query, hits: Math.max(0, count - (titles.length - nonYtTitles.length)), sampleTitles: nonYtTitles };
}

/** Aggregate signal for a candidate. Combines reddit + web into one score the ranker consumes. */
export async function mentionSignal(videoTitle: string, channelTitle: string): Promise<{ reddit: MentionCount; web: MentionCount; totalHits: number }> {
  // Query shape: "<channel> <title>" catches variants where the YT title alone is too generic.
  const query = `${channelTitle} ${videoTitle}`.slice(0, 200);
  const [reddit, web] = await Promise.all([redditMentions(query), webMentions(query)]);
  return { reddit, web, totalHits: reddit.hits + web.hits };
}

/** Check whether the CLI is reachable at all. Cheap probe; used by discover to decide whether to
 *  bother enriching candidates (the full-pipeline cost of ~5 candidates × 2 platforms × ~2s each
 *  is wasted if the CLI isn't there). */
export async function agentReachAvailable(): Promise<boolean> {
  const stdout = await runAgentReach(["--help"]);
  return stdout !== null;
}
