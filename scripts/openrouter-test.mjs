/**
 * node scripts/openrouter-test.mjs
 * Reproduces the EXACT chat request the pipeline sends to OpenRouter, after loading .env the same
 * way the app does, and prints what was sent. Separates "bad key" from "bad request".
 */
import fs from "node:fs";

// Load .env exactly like the app: LAST value of a duplicated key wins, same as dotenv/tsx.
const seen = {};
try {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) seen[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const dupCount = fs.existsSync(".env")
  ? fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.startsWith("OPENROUTER_API_KEY=")).length
  : 0;

const key = seen.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || "";
console.log(`OPENROUTER_API_KEY lines in .env: ${dupCount}${dupCount > 1 ? "  ⚠️ DUPLICATE — the app uses the LAST one" : ""}`);
console.log(`key used: ${key ? `${key.length} chars, ${key.slice(0, 12)}…${key.slice(-4)}` : "EMPTY"}`);
if (!key) { console.log("❌ no key resolved from .env"); process.exit(1); }

const model = process.argv[2] || seen.OPENROUTER_MODEL_VISION || "google/gemma-3-4b-it:free";
console.log(`model: ${model}\n`);

// 1) auth check
const auth = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${key}` } });
console.log(`/auth/key -> HTTP ${auth.status}${auth.ok ? "  ✅ key is live" : "  ❌ key rejected"}`);
if (!auth.ok) { console.log("   => the key line the app reads is wrong. Fix the duplicate below."); process.exit(1); }

// 2) the real chat request, text-only (a vision model still answers text)
const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`, "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/yt-autopilot", "X-Title": "yt-autopilot",
  },
  body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: 'reply {"ok":true}' }] }),
});
const body = await r.text();
console.log(`/chat/completions -> HTTP ${r.status}`);
console.log(r.ok ? "✅ THE PIPELINE REQUEST WORKS." : `❌ ${body.slice(0, 200)}`);
if (!r.ok) {
  if (/unavailable for free|paid version/i.test(body)) {
    console.log("\nThis model is no longer free. Finding one that is...");
    const ms = await fetch("https://openrouter.ai/api/v1/models").then((x) => x.json()).catch(() => ({ data: [] }));
    const free = (ms.data ?? []).filter((m) => {
      const pr = m.pricing ?? {}; const mods = m.architecture?.input_modalities ?? [];
      return (Number(pr.prompt) || 0) === 0 && (Number(pr.completion) || 0) === 0 &&
        (Array.isArray(mods) ? mods.some((x) => /image/i.test(x)) : false) && /:free$/.test(m.id ?? "");
    }).map((m) => m.id);
    console.log(free.length ? `Free vision models right now:\n  ${free.join("\n  ")}` : "No free vision models on OpenRouter right now — use Groq (already working).");
    if (free[0]) console.log(`\nSet it:  echo 'OPENROUTER_MODEL_VISION=${free[0]}' >> .env  &&  npm run github`);
  } else if (/User not found|401/.test(body)) {
    console.log("\nfree models need training ON: openrouter.ai/settings/privacy");
  }
}
