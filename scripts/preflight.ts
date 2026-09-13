/** `npm run preflight` - everything that must be true before pushing to GitHub. */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadChannel, loadLearned, ROOT } from "../src/config";

let fail = 0;
const ok = (name: string, info = "") => console.log(`✅ ${name}${info ? ` — ${info}` : ""}`);
const bad = (name: string, why: string, fix: string) => { fail++; console.log(`❌ ${name}\n   ${why}\n   FIX: ${fix}`); };
const warn = (name: string, why: string) => console.log(`⚠️  ${name} — ${why}`);

// 1. code compiles
try { execSync("npx tsc --noEmit", { cwd: ROOT, stdio: "pipe" }); ok("TypeScript compiles"); }
catch (e) { bad("TypeScript compiles", String((e as { stdout?: Buffer }).stdout ?? e).slice(0, 300), "send me this output"); }

// 2. channel config is valid and filled in
try {
  const cfg = loadChannel();
  if (cfg.channelName === "CHANGE_ME") bad("channel name", 'still "CHANGE_ME"', "npm run setup");
  else ok("channel config", `${cfg.channelName} · ${cfg.subNiches.length} sub-niches · ${cfg.maxVideosPerWeek}/week · sources: ${cfg.imageSources.join(", ")}`);
  if (cfg.videoClipRatio > 0 && !process.env.PEXELS_API_KEY) warn("motion clips", "videoClipRatio > 0 but no PEXELS_API_KEY — stills only");
} catch (e) { bad("channel config", (e as Error).message.slice(0, 200), "check config/channel.json"); }

// 2b. what the weekly learning job may change on its own
{
  const cfg = loadChannel();
  const l = loadLearned();
  ok("learning limits",
    `cadence ${cfg.maxVideosPerWeek}/week (may reach ${cfg.learning.cadenceCeiling}) · ` +
    `may add up to ${cfg.learning.maxLearnedSubNiches} topic areas (${(l.addedSubNiches ?? []).length} so far) · ` +
    `${cfg.learning.autoApply ? "applies changes directly" : "opens a pull request for you"}`);
}

// 2c. confirm every scheduled job runs on GitHub, not this machine
{
  const cfg = loadChannel();
  ok("where work happens", `scheduled runs: GitHub Actions only · this Mac: only \`npm run video:local\` (asks first, low-power)`);
  ok("publishing model",
    `${cfg.maxVideosPerWeek} long + ${cfg.shortsPerWeek} shorts per week, drawn from a backlog of ${cfg.backlogTarget} · ` +
    `shorts always come from different videos than that week's longs`);
  ok("pre-production gate", `scripts predicted below ${cfg.approval.minScore}/10 are repaired, below ${cfg.approval.minScore - 1.5}/10 are abandoned before any CPU is spent`);
}

// 3. ffmpeg features this pipeline uses
const filters = (() => { try { return execSync("ffmpeg -hide_banner -filters", { stdio: "pipe" }).toString(); } catch { return ""; } })();
if (!filters) bad("ffmpeg", "not found", "brew install ffmpeg");
else {
  for (const [f, why, fix] of [
    ["zoompan", "scene motion", "brew install ffmpeg-full"],
    ["xfade", "crossfades", "brew install ffmpeg-full"],
    ["drawtext", "thumbnail text", "brew install ffmpeg-full (optional: thumbnails render without text)"],
    ["subtitles", "burned-in Short captions", "brew install ffmpeg-full (optional: Shorts ship without captions)"],
  ] as const) {
    if (new RegExp(`^\\s*\\S+\\s+${f}\\s`, "m").test(filters)) ok(`ffmpeg ${f}`, why);
    else warn(`ffmpeg ${f}`, `missing — ${why} degrades. ${fix}`);
  }
}

// 4. secrets exist locally and are not committed
const required = ["DATABASE_URL", "YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"];
const cred: Record<string, string> = { gemini: "GEMINI_API_KEY", "claude-code": "CLAUDE_CODE_OAUTH_TOKEN", anthropic: "ANTHROPIC_API_KEY", "openai-compatible": "OPENAI_COMPAT_API_KEY" };
const provider = process.env.LLM_PROVIDER || "gemini";
const missing = [...required, cred[provider] ?? "GEMINI_API_KEY"].filter((k) => !process.env[k]);
if (missing.length) bad("secrets in .env", `missing ${missing.join(", ")}`, "npm run setup");
else ok("secrets in .env", `provider: ${provider}`);

if (fs.existsSync(path.join(ROOT, ".env"))) {
  const ignored = spawnSync("git", ["check-ignore", "-q", ".env"], { cwd: ROOT }).status === 0;
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: ROOT, stdio: "pipe" }).status === 0;
  if (tracked) bad(".env is committed", "your keys would be published", "git rm --cached .env && git commit -m 'remove .env'");
  else if (!ignored && fs.existsSync(path.join(ROOT, ".git"))) bad(".env not ignored", "it would be pushed", "add .env to .gitignore");
  else ok(".env stays local");
}

// 5. workflows present
for (const w of ["produce", "approve", "analytics", "learn", "migrate", "queue"]) {
  const p = path.join(ROOT, `.github/workflows/${w}.yml`);
  if (fs.existsSync(p)) ok(`workflow ${w}.yml`); else bad(`workflow ${w}.yml`, "missing", "re-unzip the project");
}

// 6. live services
console.log("\n--- live service checks ---");
const r = spawnSync("npm", ["run", "-s", "check"], { cwd: ROOT, stdio: "inherit" });
if (r.status !== 0) fail++;

console.log(fail ? `\n❌ ${fail} blocking problem(s). Fix them before pushing.` : `\n✅ Ready. Next: npm run github`);
process.exit(fail ? 1 : 0);
