/** `npm run check` - verifies every dependency before a real run. */
import { execSync } from "node:child_process";
import { google } from "googleapis";
import pg from "pg";
import { z } from "zod";
import { askJson } from "../src/lib/llm";

let failed = 0;
async function step(name: string, fix: string, fn: () => Promise<string | void>) {
  try {
    const info = await fn();
    console.log(`✅ ${name}${info ? ` - ${info}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${name}\n   ${(e as Error).message.split("\n")[0]}\n   FIX: ${fix}`);
  }
}

const PROVIDER = process.env.LLM_PROVIDER || "gemini";
const CRED: Record<string, string> = { gemini: "GEMINI_API_KEY", "claude-code": "CLAUDE_CODE_OAUTH_TOKEN", anthropic: "ANTHROPIC_API_KEY", "openai-compatible": "OPENAI_COMPAT_API_KEY" };

await step("env vars", "run `npm run setup`", async () => {
  const missing = [CRED[PROVIDER] ?? "GEMINI_API_KEY", "DATABASE_URL", "YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return `provider: ${PROVIDER}`;
});
await step("ffmpeg", "brew install ffmpeg", async () => execSync("ffmpeg -version").toString().split("\n")[0]!.slice(0, 40));
if (PROVIDER === "claude-code") {
  await step("Claude Code CLI", "curl -fsSL https://claude.ai/install.sh | bash   (then open a new terminal)", async () => execSync("claude --version").toString().trim());
}
await step(`AI provider (${PROVIDER})`, PROVIDER === "gemini"
  ? "run `npm run models` (it picks a model your key can actually call)"
  : "re-run `npm run setup` and paste a fresh credential", async () => {
  const r = await askJson({ tier: "light", system: "You answer in JSON.", prompt: 'Reply with {"ok": true}', schema: z.object({ ok: z.boolean() }) });
  return `answered ok=${r.ok}`;
});
await step("Postgres", "check DATABASE_URL (copy the whole string from Neon)", async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } });
  await c.connect();
  const t = await c.query("select to_regclass('public.videos') as t");
  await c.end();
  if (!t.rows[0].t) throw new Error("connected, but tables are missing");
  return "tables present";
});
const auth = new google.auth.OAuth2(process.env.YT_CLIENT_ID, process.env.YT_CLIENT_SECRET);
auth.setCredentials({ refresh_token: process.env.YT_REFRESH_TOKEN });
await step("YouTube Data API", "run `npm run setup` again and sign in with the account that OWNS the channel", async () => {
  const r = await google.youtube({ version: "v3", auth }).channels.list({ part: ["snippet", "statistics"], mine: true });
  const ch = r.data.items?.[0];
  if (!ch) throw new Error("token works but this Google account has no YouTube channel");
  return `channel "${ch.snippet?.title}" (${ch.statistics?.subscriberCount ?? 0} subs)`;
});
await step("YouTube Analytics API", "enable 'YouTube Analytics API' in Google Cloud (APIs & Services -> Library)", async () => {
  const d = (n: number) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
  await google.youtubeAnalytics({ version: "v2", auth }).reports.query({ ids: "channel==MINE", startDate: d(30), endDate: d(1), metrics: "views" });
  return "reachable";
});
await step("NASA image library", "temporary outage, retry later", async () => {
  const r = await fetch("https://images-api.nasa.gov/search?media_type=image&page_size=1&q=nebula");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
});
await step("Pexels (optional)", "add PEXELS_API_KEY via `npm run setup`, or ignore to use Wikimedia + NASA only", async () => {
  if (!process.env.PEXELS_API_KEY) return "not set — stills from Wikimedia/NASA only, no motion clips";
  const r = await fetch("https://api.pexels.com/v1/search?query=library&per_page=1", { headers: { Authorization: process.env.PEXELS_API_KEY } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return "reachable";
});
await step("Wikimedia Commons", "temporary outage, retry later", async () => {
  const r = await fetch("https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=File:Example.jpg&prop=imageinfo&iiprop=extmetadata", { headers: { "User-Agent": "yt-autopilot-check/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
});
await step("Wikipedia", "temporary outage, retry later", async () => {
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=Voyager&format=json", { headers: { "User-Agent": "yt-autopilot-check/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
});

console.log(failed ? `\n${failed} check(s) failed. Fix the first ❌ and run \`npm run check\` again.` : "\n✅ All checks passed.");
process.exitCode = failed ? 1 : 0;
