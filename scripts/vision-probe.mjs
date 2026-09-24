/**
 * node scripts/vision-probe.mjs (or npm run vision:probe)
 *
 * Finds a working VISION model for each configured provider by ASKING the provider what it serves
 * (its /models endpoint) and testing each plausible one with a real image, then writes the winner to
 * .env. This is robust to providers renaming or retiring models, which they do often.
 */
import fs from "node:fs";

// Load .env ourselves; this may run as plain `node`, which does not read it.
try {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* rely on real env */ }

const PX = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAABwEBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAQABAAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjgDf0sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/9k=";

const PROVIDERS = [
  { name: "groq", base: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY, envVar: "GROQ_MODEL_VISION",
    // words that mark a likely vision model in an id, newest-looking first
    hint: (id) => /vision|scout|maverick|llama-4|qwen3\.?[0-9]|3\.8|vl|multimodal/i.test(id) },
  { name: "zai", base: "https://open.bigmodel.cn/api/paas/v4", key: process.env.ZAI_API_KEY, envVar: "ZAI_MODEL_VISION",
    hint: (id) => /v(?:ision)?\b|4v|4\.5v|glm-4v|vl/i.test(id) },
];

async function listModels(base, key) {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { err: `${r.status}: ${(await r.text()).slice(0, 80)}` };
    const j = await r.json();
    return { ids: (j.data ?? j.models ?? []).map((m) => m.id ?? m.model ?? m.name).filter(Boolean) };
  } catch (e) { return { err: e.message.slice(0, 70) }; }
}

async function takesImage(base, key, model) {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: [
        { type: "text", text: 'reply {"ok":true}' },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PX}` } },
      ] }] }),
      signal: AbortSignal.timeout(40000),
    });
    if (r.ok) return { ok: true };
    return { ok: false, why: `${r.status}: ${(await r.text()).slice(0, 70)}` };
  } catch (e) { return { ok: false, why: e.message.slice(0, 60) }; }
}

let env = fs.readFileSync(".env", "utf8");
let changed = false, anyWorking = false;

for (const p of PROVIDERS) {
  if (!p.key) { console.log(`\n${p.name}: no key in .env, skipping`); continue; }
  console.log(`\n${p.name}: asking what your key can serve...`);
  const { ids, err } = await listModels(p.base, p.key);
  if (err) { console.log(`  couldn't list models (${err}) — falling back to a fixed guess list`); }
  // candidates: models the provider lists whose id looks multimodal, plus a few known ids as backup
  const guesses = p.name === "groq"
    ? ["qwen/qwen3.8-27b", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct"]
    : ["glm-4v-flash", "glm-4v"];
  const listed = (ids ?? []).filter(p.hint);
  const candidates = [...new Set([...listed, ...guesses])];
  if (!candidates.length) { console.log(`  no vision-looking models found for ${p.name}.`); continue; }

  let found = null;
  for (const m of candidates) {
    process.stdout.write(`  test ${m} ... `);
    const r = await takesImage(p.base, p.key, m);
    console.log(r.ok ? "✅ works" : `❌ ${r.why}`);
    if (r.ok) { found = m; break; }
    await new Promise((x) => setTimeout(x, 1500));
  }
  if (found) {
    anyWorking = true;
    env = new RegExp(`^${p.envVar}=.*$`, "m").test(env)
      ? env.replace(new RegExp(`^${p.envVar}=.*$`, "m"), `${p.envVar}=${found}`)
      : `${env.trimEnd()}\n${p.envVar}=${found}\n`;
    changed = true;
    console.log(`  -> ${p.envVar}=${found}`);
  } else {
    console.log(`  ${p.name}: no model accepted an image. If you saw "insufficient balance", this provider's free vision tier has ended.`);
  }
}

if (changed) fs.writeFileSync(".env", env);
console.log(anyWorking
  ? "\n✅ A working vision model was found and saved to .env. Run: npm run github, then npm run select:test"
  : "\n❌ No provider served a free vision model. Options: fix the Gemini API key (aistudio.google.com/apikey, starts AIza, free), or see SETUP.md for other providers.");
process.exitCode = anyWorking ? 0 : 1;
