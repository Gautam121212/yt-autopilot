/**
 * `npm run models:mistral` — asks Mistral which models your key may actually call, probes them with
 * a real JSON request, and writes the working ones into .env.
 *
 * A free key is not entitled to `mistral-large-latest`; asking for it returns 403 and the routed
 * call silently falls back to Gemini, which is exactly the failure this avoids.
 */
import fs from "node:fs";

const base = (process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1").replace(/\/$/, "");
const key = process.env.MISTRAL_API_KEY;
if (!key) throw new Error("Set MISTRAL_API_KEY in .env first (mistral.ai → La Plateforme → API keys)");

const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) throw new Error(`${base}/models -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
const { data = [] } = (await res.json()) as { data?: { id: string }[] };

const ids = data.map((m) => m.id)
  .filter((id) => !/embed|moderation|ocr|voxtral|codestral-mamba/i.test(id))
  .sort();
console.log(`Models your key lists (${ids.length}):\n${ids.map((i) => `  ${i}`).join("\n")}\n`);

async function probe(model: string): Promise<string | null> {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: "Answer in JSON." }, { role: "user", content: 'Reply {"ok":true}' }],
      max_tokens: 60,
      response_format: { type: "json_object" },
    }),
  });
  if (r.ok) return null;
  const body = (await r.text()).slice(0, 140);
  return `${r.status}${r.status === 403 ? " (not entitled)" : ""}: ${body}`;
}

// Bigger first for the heavy slot, but only among models that actually answer.
const rank = (id: string) => (/large/.test(id) ? 4 : /medium/.test(id) ? 3 : /small/.test(id) ? 2 : /nemo|ministral/.test(id) ? 1 : 0);
const working: string[] = [];
for (const m of [...ids].sort((a, b) => rank(b) - rank(a)).slice(0, 10)) {
  process.stdout.write(`testing ${m} ... `);
  const err = await probe(m);
  console.log(err ?? "✅ works");
  if (!err) working.push(m);
  if (working.length >= 2) break;
  await new Promise((r) => setTimeout(r, 600));
}
if (!working.length) throw new Error("none of the listed models accepted a request — check the key's plan at console.mistral.ai");

const heavy = working[0]!;
const light = working[1] ?? heavy;
let env = fs.readFileSync(".env", "utf8");
for (const [k, v] of [["MISTRAL_MODEL_HEAVY", heavy], ["MISTRAL_MODEL_LIGHT", light]] as const) {
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
}
fs.writeFileSync(".env", env);
console.log(`\n✅ heavy = ${heavy}\n✅ light = ${light}\n(saved to .env — run npm run github to push)`);
export {};
