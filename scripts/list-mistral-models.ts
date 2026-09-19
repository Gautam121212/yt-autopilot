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
  // Aliases duplicate a dated id and can resolve to something the key cannot use, so skip them.
  .filter((id) => !/embed|moderation|ocr|voxtral|codestral|vibe|-latest$|^mistral-medium$/i.test(id))
  .sort();
console.log(`Models your key lists (${ids.length}):\n${ids.map((i) => `  ${i}`).join("\n")}\n`);

/** Most models are capped at 1.00 requests/second. Probe slower than that, always. */
const PACE_MS = Number(process.env.MISTRAL_PACE_MS ?? 2500);

async function probe(model: string, attempt = 1): Promise<string | null> {
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
  // A 429 usually means we asked too fast, not that the model is unavailable. Back off and retry
  // before condemning it — that mistake reported a working key as completely broken.
  if (r.status === 429 && attempt < 3) {
    const wait = 4000 * attempt;
    process.stdout.write(`rate limited, waiting ${wait / 1000}s ... `);
    await new Promise((x) => setTimeout(x, wait));
    return probe(model, attempt + 1);
  }
  const body = (await r.text()).slice(0, 120);
  const why = r.status === 403 ? " (key not entitled to this model)"
    : r.status === 429 ? " (this plan is not served this model — trying the next one)"
    : "";
  return `${r.status}${why}: ${body}`;
}

/**
 * Rank by the throughput the account actually grants, not by how impressive the name is.
 * From admin.mistral.ai -> Limits: ministral-3b gets 1.3M tokens/min at 12.5 req/s, ministral-8b
 * 625k at 3.13, while the whole mistral-medium family sits at 20k and returns 1300 on this plan.
 * Ranking by name is why the probe only ever tested models that do not work here.
 */
const rank = (id: string) =>
  /ministral-14b/.test(id) ? 6
  : /ministral-8b/.test(id) ? 5
  : /ministral-3b/.test(id) ? 4
  : /leanstral/.test(id) ? 3
  : /mistral-large/.test(id) ? 2
  : /medium|small/.test(id) ? 1
  : 0;
const working: string[] = [];
// Probe every listed model if needed: stopping early is what hid the working ones.
for (const m of [...ids].sort((a, b) => rank(b) - rank(a))) {
  process.stdout.write(`testing ${m} ... `);
  const err = await probe(m);
  console.log(err ?? "✅ works");
  if (!err) working.push(m);
  if (working.length >= 2) break;
  await new Promise((r) => setTimeout(r, PACE_MS));
}

if (!working.length) {
  const allRateLimited = true; // every probe failed; the common cause is an unactivated workspace
  console.log("\n❌ No model accepted a request.");
  if (allRateLimited) {
    console.log(`
A 429 on EVERY model — including the small ones — almost never means you are actually sending too
much. It means the workspace has no active free quota yet. Mistral requires phone verification
before the free "Experiment" tier serves any request:

  1. console.mistral.ai → Workspace → Billing / Plans
  2. Activate the free Experiment tier (phone verification, no card)
  3. Wait a minute, then run \`npm run models:mistral\` again

Until then the pipeline runs fine on Gemini alone — routed calls fall through automatically, which
is what you saw in the last run. Nothing is broken; the split just is not active yet.`);
  }
  process.exitCode = 1;
} else {

  const heavy = working[0]!;
  const light = working[1] ?? heavy;
  let env = fs.readFileSync(".env", "utf8");
  for (const [k, v] of [["MISTRAL_MODEL_HEAVY", heavy], ["MISTRAL_MODEL_LIGHT", light]] as const) {
    env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  }
  fs.writeFileSync(".env", env);
  console.log(`\n✅ heavy = ${heavy}\n✅ light = ${light}\n(saved to .env — run npm run github to push)`);
}
export {};
