/**
 * `npm run setup` - picks your AI provider, asks for each value, validates it, writes .env,
 * signs in to YouTube, creates the database tables, runs all checks. Safe to re-run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline/promises";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
if (!fs.existsSync(".env")) fs.copyFileSync(".env.example", ".env");
let envText = fs.readFileSync(".env", "utf8");
const get = (k: string) => envText.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
const set = (k: string, v: string) => {
  envText = new RegExp(`^${k}=.*$`, "m").test(envText) ? envText.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${envText.trimEnd()}\n${k}=${v}\n`;
  fs.writeFileSync(".env", envText);
};
type Field = { key: string; how: string; valid: (v: string) => boolean; hint: string };

const PROVIDERS: Record<string, { label: string; fields: Field[] }> = {
  gemini: {
    label: "Gemini free tier  (no card, no subscription)",
    fields: [{
      key: "GEMINI_API_KEY",
      how: "aistudio.google.com/apikey -> Create API key -> copy it. Do NOT enable billing on that project.",
      valid: (v) => v.length > 20 && !v.includes(" "),
      hint: "that doesn't look like an API key",
    }],
  },
  "claude-code": {
    label: "Claude Pro/Max subscription  (best quality; needs a paid Claude plan)",
    fields: [{
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      how: "Run `claude setup-token` in another terminal tab, approve in the browser, copy the token.",
      valid: (v) => v.startsWith("sk-ant-oat"),
      hint: "should start with sk-ant-oat",
    }],
  },
  "openai-compatible": {
    label: "Groq / OpenRouter / Cerebras / Mistral  (free tiers, OpenAI-compatible)",
    fields: [
      { key: "OPENAI_COMPAT_BASE_URL", how: "Groq: https://api.groq.com/openai/v1 · OpenRouter: https://openrouter.ai/api/v1 · Cerebras: https://api.cerebras.ai/v1", valid: (v) => /^https:\/\//.test(v), hint: "should start with https://" },
      { key: "OPENAI_COMPAT_API_KEY", how: "The API key from that provider's console.", valid: (v) => v.length > 15, hint: "looks too short" },
      { key: "OPENAI_COMPAT_MODEL_HEAVY", how: "Model id for scripts, e.g. a large open model your provider lists.", valid: (v) => v.length > 2, hint: "enter a model id" },
      { key: "OPENAI_COMPAT_MODEL_LIGHT", how: "Model id for topic + research (can be the same one).", valid: (v) => v.length > 2, hint: "enter a model id" },
    ],
  },
  anthropic: {
    label: "Anthropic API key  (pay per use, roughly $2-5 per video)",
    fields: [{
      key: "ANTHROPIC_API_KEY",
      how: "platform.claude.com -> API keys -> Create key.",
      valid: (v) => v.startsWith("sk-ant-"),
      hint: "should start with sk-ant-",
    }],
  },
};

const COMMON: Field[] = [
  { key: "DATABASE_URL", how: "neon.tech -> your project -> Connect -> copy the connection string.", valid: (v) => /^postgres(ql)?:\/\//.test(v), hint: "should start with postgresql://" },
  { key: "YT_CLIENT_ID", how: "Google Cloud -> Google Auth Platform -> Clients -> your Web client -> Client ID.", valid: (v) => v.endsWith(".apps.googleusercontent.com"), hint: "should end with .apps.googleusercontent.com" },
  { key: "YT_CLIENT_SECRET", how: "Same client page -> Client secret.", valid: (v) => v.length > 10, hint: "looks too short" },
];

console.log("\n=== yt-autopilot setup ===   (press Enter to keep an existing value)\n");
const keys = Object.keys(PROVIDERS);
keys.forEach((k, i) => console.log(`  ${i + 1}) ${PROVIDERS[k]!.label}`));
const current = get("LLM_PROVIDER") || "gemini";
const pick = (await rl.question(`\nWhich one? 1-${keys.length} (Enter = ${keys.indexOf(current) + 1}): `)).trim();
const provider = keys[(Number(pick) || keys.indexOf(current) + 1) - 1] ?? "gemini";
set("LLM_PROVIDER", provider);
console.log(`\nUsing: ${PROVIDERS[provider]!.label}\n`);

for (const f of [...PROVIDERS[provider]!.fields, ...COMMON]) {
  const cur = get(f.key);
  for (;;) {
    console.log(`${f.key}\n  where: ${f.how}`);
    const ans = (await rl.question(`  paste${cur ? " (Enter = keep current)" : ""}: `)).trim().replace(/^"|"$/g, "");
    const val = ans || cur;
    if (f.valid(val)) { set(f.key, val); console.log("  ✅ saved\n"); break; }
    console.log(`  ❌ ${f.hint}. Try again.\n`);
  }
}

// Optional: free stock photos and motion clips.
{
  const cur = get("PEXELS_API_KEY");
  console.log(`PEXELS_API_KEY (optional — free stock photos + motion clips)\n  where: pexels.com/api -> Get Started -> copy the key. Press Enter to skip.`);
  const ans = (await rl.question(`  paste${cur ? " (Enter = keep current)" : " or Enter to skip"}: `)).trim();
  const val = ans || cur;
  if (val) { set("PEXELS_API_KEY", val); console.log("  ✅ saved\n"); } else console.log("  skipped (Wikimedia + NASA only)\n");
}

const cfgPath = "config/channel.json";
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const name = (await rl.question(`Channel name (Enter = keep "${cfg.channelName}"): `)).trim();
if (name) { cfg.channelName = name; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n"); }
rl.close();

const run = (label: string, cmd: string, args: string[]) => {
  console.log(`\n--- ${label} ---`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) { console.log(`\n❌ ${label} failed. Fix the message above, then run \`npm run setup\` again.`); process.exit(1); }
};
if (provider === "gemini") run("Pick a Gemini model", "npm", ["run", "-s", "models"]);
if (!get("YT_REFRESH_TOKEN")) run("YouTube sign-in", "npm", ["run", "-s", "auth:youtube"]);
run("Create database tables", "npm", ["run", "-s", "migrate"]);
run("Health check", "npm", ["run", "-s", "check"]);
console.log("\nNext: npm run video:local");
