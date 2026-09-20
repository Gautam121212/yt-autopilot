/**
 * `npm run providers` — sends one real JSON request to every configured provider and reports what
 * works, what is rate-limited, and what is misconfigured.
 *
 * Tests what the pipeline actually does (a JSON-mode chat completion), not just whether the key
 * authenticates — a key can list models and still be refused a completion.
 */
import { fallbackChain } from "../src/lib/llm";

type P = { name: string; baseUrl: string; key: string; heavy: string; light: string; signup: string; note: string };

const PROVIDERS: P[] = [
  { name: "mistral", baseUrl: process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1",
    key: process.env.MISTRAL_API_KEY || "", heavy: process.env.MISTRAL_MODEL_HEAVY || "ministral-14b-2512",
    light: process.env.MISTRAL_MODEL_LIGHT || "ministral-3b-2512",
    signup: "mistral.ai → La Plateforme → API keys", note: "~1B tokens/month" },
  { name: "zai", baseUrl: process.env.ZAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    key: process.env.ZAI_API_KEY || "", heavy: process.env.ZAI_MODEL_HEAVY || "glm-4.7-flash",
    light: process.env.ZAI_MODEL_LIGHT || "glm-4.5-flash",
    signup: "open.bigmodel.cn → API keys", note: "200K context, permanent free" },
  { name: "groq", baseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
    key: process.env.GROQ_API_KEY || "", heavy: process.env.GROQ_MODEL_HEAVY || "openai/gpt-oss-120b",
    light: process.env.GROQ_MODEL_LIGHT || "llama-3.1-8b-instant",
    signup: "console.groq.com/keys", note: "1,000 req/day" },
  { name: "cerebras", baseUrl: process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
    key: process.env.CEREBRAS_API_KEY || "", heavy: process.env.CEREBRAS_MODEL_HEAVY || "gpt-oss-120b",
    light: process.env.CEREBRAS_MODEL_LIGHT || "gpt-oss-120b",
    signup: "cloud.cerebras.ai", note: "1M tokens/day, 8K context" },
  { name: "nvidia", baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    key: process.env.NVIDIA_API_KEY || "", heavy: process.env.NVIDIA_MODEL_HEAVY || "meta/llama-3.3-70b-instruct",
    light: process.env.NVIDIA_MODEL_LIGHT || "meta/llama-3.1-8b-instruct",
    signup: "build.nvidia.com → your key", note: "40 req/min" },
  { name: "openrouter", baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    key: process.env.OPENROUTER_API_KEY || "", heavy: process.env.OPENROUTER_MODEL_HEAVY || "deepseek/deepseek-r1:free",
    light: process.env.OPENROUTER_MODEL_LIGHT || "meta-llama/llama-3.3-70b-instruct:free",
    signup: "openrouter.ai/keys", note: "~200 req/day" },
];

async function tryOne(p: P, model: string): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: "Answer in JSON." }, { role: "user", content: 'Reply {"ok":true}' }],
        max_tokens: 60,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - t0;
    if (r.ok) return { ok: true, detail: `${ms}ms` };
    const body = (await r.text()).slice(0, 110).replace(/\s+/g, " ");
    const why = r.status === 401 ? "bad key"
      : r.status === 403 ? "key not entitled to this model"
      : r.status === 404 ? "model name wrong for this provider"
      : r.status === 429 ? "rate limited / no quota"
      : `HTTP ${r.status}`;
    return { ok: false, detail: `${why} — ${body}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 90) };
  }
}

console.log("Testing every provider with a real JSON request.\n");
const working: string[] = [];

// Gemini first — it is the judge and the last-resort fallback, so it matters most.
{
  const key = process.env.GEMINI_API_KEY;
  const model = (process.env.GEMINI_MODEL_LIGHT || "gemini-2.5-flash").split(",")[0]!.trim();
  process.stdout.write(`gemini      ${model.padEnd(28)} `);
  if (!key) console.log("— no GEMINI_API_KEY");
  else {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: 'Reply {"ok":true}' }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 60 } }),
      signal: AbortSignal.timeout(45_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => (e as Error).message } as Response));
    if (r.ok) { console.log("✅ works"); working.push("gemini"); }
    else console.log(`❌ ${r.status === 429 ? "quota exhausted (resets midnight Pacific)" : `HTTP ${r.status}`} — ${(await r.text()).slice(0, 90)}`);
  }
}

for (const p of PROVIDERS) {
  process.stdout.write(`${p.name.padEnd(11)} ${p.heavy.padEnd(28)} `);
  if (!p.key) { console.log(`— no key. Get one: ${p.signup}`); continue; }
  const heavy = await tryOne(p, p.heavy);
  if (heavy.ok) { console.log(`✅ works (${heavy.detail}) · ${p.note}`); working.push(p.name); }
  else {
    console.log(`❌ ${heavy.detail}`);
    // A heavy model can be unavailable while the light one is fine — worth knowing.
    if (p.light !== p.heavy) {
      await new Promise((r) => setTimeout(r, 1500));
      process.stdout.write(`${"".padEnd(11)} ${p.light.padEnd(28)} `);
      const light = await tryOne(p, p.light);
      console.log(light.ok ? `✅ works (${light.detail}) — use this as the heavy model too` : `❌ ${light.detail}`);
      if (light.ok) working.push(`${p.name} (light only)`);
    }
  }
  await new Promise((r) => setTimeout(r, 1500)); // respect ~1 req/s limits
}

const roles = { gate: process.env.LLM_ROLE_GATE, write: process.env.LLM_ROLE_WRITE, judge: process.env.LLM_ROLE_JUDGE };
console.log(`\nroles: gate=${roles.gate || "(unset → default)"} · write=${roles.write || "(unset)"} · judge=${roles.judge || "(unset)"}`);
console.log(`fallback chain entries: ${fallbackChain().length}`);
console.log(working.length
  ? `\n✅ ${working.length} working: ${working.join(", ")}`
  : "\n❌ nothing answered — the pipeline cannot run until at least one provider works.");
if (working.length && !working.includes("gemini")) {
  console.log("⚠️  Gemini is down: the final check and image QA need vision, so those stages will hold videos for you instead.");
}
process.exitCode = working.length ? 0 : 1;
export {};
