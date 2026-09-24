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
  { name: "openrouter", base: "https://openrouter.ai/api/v1", key: process.env.OPENROUTER_API_KEY, envVar: "OPENROUTER_MODEL_VISION",
    hint: (id) => /:free/.test(id) && /vl|vision|gemma-3|llama-3\.2-11b|qwen2?\.5-vl|scout|maverick|nemotron.*vl/i.test(id) },
];

async function listModels(base, key) {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/models`, { headers: headersFor(base, key), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { err: `${r.status}: ${(await r.text()).slice(0, 80)}` };
    const j = await r.json();
    const rows = j.data ?? j.models ?? [];
    return { ids: rows.map((m) => m.id ?? m.model ?? m.name).filter(Boolean), rows };
  } catch (e) { return { err: e.message.slice(0, 70) }; }
}

/** OpenRouter model objects carry pricing + input modalities: pick genuinely-free vision models. */
function openrouterFreeVision(rows) {
  return (rows ?? [])
    .filter((m) => {
      const price = m.pricing ?? {};
      const free = (Number(price.prompt) || 0) === 0 && (Number(price.completion) || 0) === 0;
      const mods = m.architecture?.input_modalities ?? m.architecture?.modality?.split?.("+") ?? [];
      const sees = Array.isArray(mods) ? mods.some((x) => /image/i.test(x)) : /image/i.test(String(mods));
      return free && sees && /:free$/.test(m.id ?? "");
    })
    .map((m) => m.id);
}

function headersFor(base, key) {
  const h = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  // OpenRouter attributes usage to an app via these; some keys 401 without them.
  if (/openrouter\.ai/.test(base)) { h["HTTP-Referer"] = "https://github.com/yt-autopilot"; h["X-Title"] = "yt-autopilot"; }
  return h;
}

async function takesImage(base, key, model) {
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: headersFor(base, key),
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
  if (p.name === "openrouter") {
    const auth = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: headersFor(p.base, p.key) }).catch(() => null);
    if (auth && auth.status === 401) {
      console.log("  ❌ the key itself is refused (401). Causes, in order of likelihood:");
      console.log("     1. the key was made in a DIFFERENT OpenRouter account than the one you're logged into — regenerate at openrouter.ai/keys");
      console.log("     2. the key is expired — OpenRouter returns \"User not found\" for expired keys");
      console.log("     3. free models need training enabled — turn ON \"Model Training\" at openrouter.ai/settings/privacy");
      console.log("     Test directly: curl -H \"Authorization: Bearer $OPENROUTER_API_KEY\" https://openrouter.ai/api/v1/auth/key");
      continue;
    }
    if (auth && auth.ok) console.log("  key is valid ✓ (so a per-model 401 below means that model needs training enabled or credits)");
  }
  const { ids, err, rows } = await listModels(p.base, p.key);
  if (err) { console.log(`  couldn't list models (${err}) — falling back to a fixed guess list`); }
  if (p.name === "openrouter" && rows) {
    const live = openrouterFreeVision(rows);
    if (live.length) { console.log(`  ${live.length} free vision model(s) live right now: ${live.slice(0, 4).join(", ")}${live.length > 4 ? " …" : ""}`); }
  }
  // candidates: models the provider lists whose id looks multimodal, plus a few known ids as backup
  const guesses = p.name === "groq"
    ? ["qwen/qwen3.8-27b", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct"]
    : p.name === "openrouter"
    ? ["meta-llama/llama-3.2-11b-vision-instruct:free", "google/gemma-3-4b-it:free", "google/gemma-3-12b-it:free", "google/gemma-3-27b-it:free", "qwen/qwen2.5-vl-32b-instruct:free"]
    : [];
  const liveFree = p.name === "openrouter" ? openrouterFreeVision(rows) : [];
  const listed = (ids ?? []).filter(p.hint);
  const candidates = [...new Set([...liveFree, ...listed, ...guesses])];
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
    console.log(`  ${p.name}: no model accepted an image.`);
    if (p.name === "openrouter") console.log(`     "401: User not found" = the OPENROUTER_API_KEY is wrong/empty. Get a fresh one (free, email only) at openrouter.ai/keys and put it in .env.`);
  }
}

if (changed) fs.writeFileSync(".env", env);
console.log(anyWorking
  ? "\n✅ A working vision model was found and saved to .env. Run: npm run github, then npm run select:test"
  : "\n❌ No provider served a free vision model. Options: fix the Gemini API key (aistudio.google.com/apikey, starts AIza, free), or see SETUP.md for other providers.");
process.exitCode = anyWorking ? 0 : 1;
