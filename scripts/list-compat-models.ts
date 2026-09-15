/**
 * `npm run models:backup` — lists the models your OpenAI-compatible provider actually serves
 * (Groq, OpenRouter, Cerebras, Mistral, ...), probes them, and writes working ids into .env.
 * Model catalogues on free tiers change often, so never hand-type an id.
 */
import fs from "node:fs";

const base = (process.env.OPENAI_COMPAT_BASE_URL || "").replace(/\/$/, "");
const key = process.env.OPENAI_COMPAT_API_KEY;
if (!base || !key) throw new Error("Set OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY in .env first");

const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) throw new Error(`${base}/models -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
const { data = [] } = (await res.json()) as { data?: { id: string }[] };

let ids = data.map((m) => m.id)
  .filter((id) => !/whisper|tts|guard|embed|vision-only|distil|moderation/i.test(id))
  .sort();

// OpenRouter mixes free and paid in one list; only the ":free" variants cost nothing.
const freeOnly = ids.filter((id) => /:free$/i.test(id));
if (freeOnly.length) {
  console.log(`(${freeOnly.length} of ${ids.length} models are free — using only those)\n`);
  ids = freeOnly;
} else if (/openrouter/i.test(base)) {
  console.log("⚠️  No \":free\" models found. Everything on this endpoint will bill your account.\n");
}
if (!ids.length) throw new Error("provider returned no usable text models");
console.log(`Models served by ${base}:\n${ids.map((i) => `  ${i}`).join("\n")}\n`);

// Bigger models write better scripts; prefer them for "heavy", something small and fast for "light".
const size = (id: string) => Number(/(\d{2,3})\s*b/i.exec(id)?.[1] ?? 0);
const ranked = [...ids].sort((a, b) => size(b) - size(a));

async function probe(model: string): Promise<string | null> {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: "Answer in JSON." }, { role: "user", content: 'Reply {"ok":true}' }],
      max_tokens: 100,
      response_format: { type: "json_object" },
    }),
  });
  if (r.ok) return null;
  return `${r.status}: ${((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message?.slice(0, 120) ?? "failed"}`;
}

const working: string[] = [];
for (const m of ranked.slice(0, 8)) {
  process.stdout.write(`testing ${m} ... `);
  const err = await probe(m);
  console.log(err ?? "✅ works");
  if (!err) working.push(m);
  if (working.length >= 2) break;
  await new Promise((r) => setTimeout(r, 800));
}
if (!working.length) throw new Error("none of the provider's models accepted a JSON request");

const heavy = working[0]!;
const light = working[1] ?? heavy;
let env = fs.readFileSync(".env", "utf8");
for (const [k, v] of [["OPENAI_COMPAT_MODEL_HEAVY", heavy], ["OPENAI_COMPAT_MODEL_LIGHT", light]] as const) {
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
}
fs.writeFileSync(".env", env);
console.log(`\n✅ heavy = ${heavy}\n✅ light = ${light}\n(saved to .env)`);
export {};
