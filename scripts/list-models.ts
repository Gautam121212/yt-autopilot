/**
 * Lists Gemini models your key can call, PROBES them with a real generation request
 * (listing a model does not mean you may call it — older models are closed to new users),
 * then writes the best working one into .env.
 */
import fs from "node:fs";

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("Run `npm run setup` first");

const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=500", { headers: { "x-goog-api-key": key } });
if (!res.ok) throw new Error(`Gemini rejected the key (${res.status}): ${(await res.text()).slice(0, 300)}`);
const { models } = (await res.json()) as { models: { name: string; supportedGenerationMethods?: string[] }[] };

// Newest first: compare the version number in the name (3.6 beats 2.5), then the name itself.
const ver = (n: string) => Number(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
const candidates = models
  .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
  .map((m) => m.name.replace("models/", ""))
  .filter((n) => /flash/i.test(n) && !/image|tts|audio|live|embedding|exp|preview/i.test(n))
  .sort((a, b) => ver(b) - ver(a) || (/lite/i.test(a) ? 1 : 0) - (/lite/i.test(b) ? 1 : 0) || b.localeCompare(a));

if (!candidates.length) throw new Error("No flash models listed for this key");
console.log(`Flash models listed for your key:\n${candidates.map((c) => `  ${c}`).join("\n")}\n`);

async function probe(model: string): Promise<string | null> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key!, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: 'Reply with {"ok":true}' }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2000 },
    }),
  });
  if (r.ok) return null;
  const msg = ((await r.json()) as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`;
  return `${r.status}: ${msg.slice(0, 160)}`;
}

// Keep up to 3 working models: when the first is overloaded (503) the pipeline falls through to the next.
const working: string[] = [];
for (const m of candidates.slice(0, 8)) {
  process.stdout.write(`testing ${m} ... `);
  const err = await probe(m);
  console.log(err ?? "✅ works");
  if (!err) working.push(m);
  if (working.length >= 3) break;
  await new Promise((r) => setTimeout(r, 1500));
}
if (!working.length) throw new Error("None of the listed flash models accepted a request. Create a fresh key at aistudio.google.com/apikey.");
const pick = working.join(",");

let env = fs.readFileSync(".env", "utf8");
for (const k of ["GEMINI_MODEL_HEAVY", "GEMINI_MODEL_LIGHT"]) {
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${pick}`) : `${env.trimEnd()}\n${k}=${pick}\n`;
}
fs.writeFileSync(".env", env);
console.log(`\n✅ Using ${working.map((w) => `"${w}"`).join(" -> ")} (saved to .env; later models are fallbacks when the first is busy).`);
export {};
