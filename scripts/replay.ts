/**
 * `npm run replay` — replays real production failures against the actual client with a fake
 * network, and checks behaviour rather than wording. Each scenario is a run that happened.
 */
import { z } from "zod";

const Schema = z.object({ title: z.string(), scenes: z.array(z.object({ narration: z.string() })).min(2) });
const GOOD = JSON.stringify({ title: "t", scenes: [{ narration: "a" }, { narration: "b" }] });

type Call = { host: string; maxTokens?: number };
let calls: Call[] = [];
let plan: ((body: any, host: string) => { status: number; json: unknown })[] = [];

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const host = new URL(url).host;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ host, maxTokens: body.max_tokens ?? body.generationConfig?.maxOutputTokens });
  const step = plan.shift() ?? (() => ({ status: 500, json: { error: "no scripted response" } }));
  const r = step(body, host);
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const mistral = (content: string, finish = "stop") => () =>
  ({ status: 200, json: { choices: [{ message: { content }, finish_reason: finish }], usage: { completion_tokens: 4096 } } });
const geminiMaxTokens = () =>
  ({ status: 200, json: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] } });

process.env.MISTRAL_API_KEY = "test";
process.env.GEMINI_API_KEY = "test";
process.env.LLM_PROVIDER = "gemini";
process.env.GEMINI_MODEL_HEAVY = "gemini-test";
process.env.GEMINI_MODEL_LIGHT = "gemini-test";
process.env.LLM_ROLE_WRITE = "mistral";
process.env.LLM_ROLE_GATE = "mistral";
process.env.LLM_ROLE_JUDGE = "mistral";   // must be set before import: roles are read at load time
process.env.PROVIDER_MIN_GAP_MS = "0";
process.env.GEMINI_MIN_GAP_MS = "0";
for (const k of ["ZAI_API_KEY","GROQ_API_KEY","CEREBRAS_API_KEY","NVIDIA_API_KEY","OPENROUTER_API_KEY","OPENAI_COMPAT_MAX_TOKENS"]) delete process.env[k];

const { askJson } = await import("../src/lib/llm");

let bad = 0;
const check = (pass: boolean, what: string, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!pass) bad++;
};
const run = async (role: "write" | "gate") =>
  askJson({ tier: "heavy", role, schema: Schema, system: "s", prompt: "p" }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: (e as Error).message }));

// ── Scenario 1: the production failure. Mistral cut off at 4096, then Gemini hits its cap. ──
console.log("\nScenario 1 — the run that kept failing: Mistral truncated, then Gemini");
calls = []; plan = [mistral(GOOD)];
await run("write");
const mistralCall = calls.find((c) => c.host.includes("mistral"));
check((mistralCall?.maxTokens ?? 0) > 4096, "#43 Mistral is no longer capped at 4,096 output tokens",
  `asked for ${mistralCall?.maxTokens}`);

// ── Scenario 2: Mistral returns broken JSON once, then good JSON. Must NOT touch Gemini. ──
console.log("\nScenario 2 — Mistral returns unparseable JSON, then a good answer");
calls = []; plan = [mistral('{"title": "t", "scenes": [{"narr'), mistral(GOOD)];
const r2 = await run("write");
check(r2.ok, "the call succeeds on the retry");
check(!calls.some((c) => c.host.includes("googleapis")), "#44 Gemini was never called", `${calls.map((c) => c.host.split(".")[1]).join(" -> ")}`);
check(calls.filter((c) => c.host.includes("mistral")).length === 2, "#44 the retry went back to Mistral");

// ── Scenario 3: truncation reported as truncation, not as a mystery parse error. ──
console.log("\nScenario 3 — Mistral stops at max_tokens");
calls = []; plan = [mistral('{"title":"t","scenes":[{"narration":"a"}', "length"), mistral(GOOD)];
const r3 = await run("write");
check(r3.ok, "#45 a truncated answer is retried, and the retry succeeds");

// ── Scenario 4: every writer fails. A WRITE call must not burn Gemini quota. ──
console.log("\nScenario 4 — Mistral fails every attempt on a writing call");
calls = []; plan = [mistral("not json"), mistral("not json"), mistral("not json"), geminiMaxTokens, geminiMaxTokens];
const r4 = await run("write");
check(!r4.ok, "the call fails cleanly");
check(!calls.some((c) => c.host.includes("googleapis")), "#46 a writing call never falls back to Gemini",
  `${calls.length} calls, all to ${[...new Set(calls.map((c) => c.host.split(".")[1]))].join(",")}`);

// ── Scenario 5: a GATE call is different — Gemini is a legitimate last resort there. ──
console.log("\nScenario 5 — Mistral fails every attempt on a gate call");
const geminiGood = () => ({ status: 200, json: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: GOOD }] } }] } });
calls = []; plan = [mistral("not json"), mistral("not json"), mistral("not json"), geminiGood];
const r5 = await run("gate");
check(r5.ok, "#46 a gate call may still use Gemini as a last resort, and succeeds");

// ── Scenario 6: a call carrying images must reach Gemini even if its role points at Mistral. ──
console.log("\nScenario 6 — an image-bearing call whose role is routed to a text-only provider");
{
  const fs = await import("node:fs");
  const img = "/tmp/replay-pixel.jpg";
  fs.writeFileSync(img, Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"));
  process.env.LLM_ROLE_JUDGE = "mistral";
  calls = []; plan = [geminiGood];
  const r6 = await askJson({ tier: "light", role: "judge", schema: Schema, system: "s", prompt: "p", images: [img] })
    .then(() => true, () => false);
  check(r6 && !calls.some((c) => c.host.includes("mistral")), "#41 images never go to a provider that cannot see",
    `went to ${calls.map((c) => c.host.split(".")[1]).join(",")}`);
}

// ── Scenarios 7-9: the run on 21 Sep — a factually accurate script abandoned over tone. ──
{
  const { verify } = await import("../src/stages/verify");
  const script = { title: "t", scenes: [] } as never;
  const dossier = { sources: [], keyFacts: [] } as never;
  const judged = (body: unknown) => () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }] } });
  console.log("\nScenario 7 — the judge files issues under 'tone' (the category the schema used to reject)");
  calls = []; plan = [judged({ verdict: "revise", adSuitability: "likely_full", summary: "s",
    issues: [{ sceneId: 3, category: "tone", severity: "MAJOR", problem: "reads neutral", fix: "add irony" }] })];
  const v7 = await verify(script, dossier, []).then((v) => v.verdict, (e) => "ERROR: " + (e as Error).message.slice(0, 50));
  // Check the OUTCOME, not just the call count — a count of 1 once hid a call that errored.
  check(calls.length === 1 && !String(v7).startsWith("ERROR") && calls[0]!.host.includes("mistral"),
    "#48 a 'tone' issue validates first time, no retry", `${calls.length} call to ${calls[0]?.host.split(".")[1]} -> ${v7}`);

  console.log("\nScenario 8 — the actual verdict: 'factually accurate but tonal misalignment', model says abandon");
  calls = []; plan = [judged({ verdict: "abandon", adSuitability: "likely_full",
    summary: "The script is factually accurate but suffers from tonal misalignment",
    issues: [
      { sceneId: "sc2", category: "quality", severity: "major", problem: "neutral narration", fix: "understatement" },
      { sceneId: "sc5", category: "tone", severity: "major", problem: "too dramatic", fix: "deadpan" },
      { sceneId: null, category: "factual", severity: "minor", problem: "rounding", fix: "use 1,812" },
    ] })];
  const v8 = await verify(script, dossier, []);
  check(v8.verdict === "pass", "#47 a factually accurate script PASSES the fact check", `verdict: ${v8.verdict}`);
  check(v8.issues.length === 0, "#47 tone issues do not reach the reviser", `${v8.issues.length} blocking`);
  check(v8.summary.includes("advisory"), "#47 tone notes are kept as advisory, not lost");

  console.log("\nScenario 9 — a genuine factual blocker must still stop the script");
  calls = []; plan = [judged({ verdict: "abandon", adSuitability: "likely_full", summary: "s",
    issues: [{ sceneId: "sc4", category: "factual", severity: "blocker", problem: "invented death toll", fix: "remove" }] })];
  const v9 = await verify(script, dossier, []);
  check(v9.verdict === "abandon" && v9.issues.length === 1, "#47 real factual blockers still abandon", `verdict: ${v9.verdict}`);
}

// ── Scenarios 10-12: the run on 21 Sep 19:00 — an 11-scene script rejected three times. ──
{
  const { ScriptSchema, TARGET_SCENES } = await import("../src/types");
  const { normaliseSceneCount } = await import("../src/stages/script");
  const para = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} tells a specific part of the story here.`).join(" ");
  const sc = (id: string, role: string, sentences: number) => ({
    id, role, narration: para(sentences), imageQuery: "cattle wagon", altQueries: ["rail yard", "old scales"],
    motion: "clip", era: "any", cardHeadline: "H", cardSub: "s", claimIds: [],
  });
  // Exactly what the per-role table allowed at its minimums: 1+1+1+4+1+1+1+1 = 11 scenes.
  const eleven = {
    title: "t", altTitles: ["a", "b", "c"], description: "d", tags: [], thumbnailText: "THEY WEIGHED THE COWS",
    thumbnailQuery: "q", claims: [],
    short: { title: "s", scenes: ["cold_open", "escalation", "kicker"].map((r, i) => ({ id: `sh${i}`, role: r, narration: "n",
      imageQuery: "q", altQueries: ["a", "b"], motion: "clip", era: "any", cardHeadline: "H", cardSub: "s" })) },
    scenes: [sc("s1", "cold_open", 4), sc("s2", "reaction", 3), sc("s3", "premise", 6),
      sc("s4", "escalation", 8), sc("s5", "escalation", 8), sc("s6", "escalation", 8), sc("s7", "escalation", 8),
      sc("s8", "turn", 7), sc("s9", "mechanism", 10), sc("s10", "payoff", 6), sc("s11", "kicker", 4)],
  };

  console.log("\nScenario 10 — the rejected answer: an 11-scene script");
  const parsed = ScriptSchema.safeParse(eleven);
  check(parsed.success, "#50 a complete 11-scene script is accepted, not binned", parsed.success ? "accepted" : parsed.error.issues[0]!.message);

  console.log("\nScenario 11 — it is brought up to 13 for free, and still obeys the beat sheet");
  const fixed = normaliseSceneCount(eleven as never) as typeof eleven;
  const beat = ScriptSchema.safeParse(fixed);
  check(fixed.scenes.length >= TARGET_SCENES, "#50 split to the target", `${eleven.scenes.length} -> ${fixed.scenes.length}`);
  check(beat.success, "#50 the split script still satisfies every beat-sheet rule");
  check(fixed.scenes[0]!.role === "cold_open" && fixed.scenes[1]!.role === "reaction" && fixed.scenes.at(-1)!.role === "kicker",
    "#50 cold_open / reaction / kicker positions untouched");
  const before = eleven.scenes.map((x) => x.narration).join(" ");
  const after = fixed.scenes.map((x) => x.narration).join(" ");
  check(before === after, "#50 not one word of narration added, lost or reordered");
  const ids = fixed.scenes.map((x) => x.id);
  check(new Set(ids).size === ids.length, "#50 every scene id stays unique");
  const split = fixed.scenes.find((x) => x.id.includes("b"));
  check(!!split && split.imageQuery !== fixed.scenes[fixed.scenes.indexOf(split) - 1]!.imageQuery,
    "#50 the new half gets a different picture, so the cut is visible");

  console.log("\nScenario 12 — a script already at 13+ is left exactly as it was");
  const thirteen = { ...eleven, scenes: [...eleven.scenes.slice(0, 7), sc("x1", "escalation", 5), sc("x2", "mechanism", 5), ...eleven.scenes.slice(7)] };
  check(JSON.stringify(normaliseSceneCount(thirteen as never)) === JSON.stringify(thirteen), "#50 no change when nothing needs fixing");
}

// ── Scenarios 13-15: the run on 22 Sep — production paused by its own rejection count. ──
{
  const { topicLessons, scriptLessons, formatLessons } = await import("../src/lib/lessons");

  console.log("\nScenario 13 — the lessons loop must never break topic picking or writing");
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
  const [tl, sl] = await Promise.all([
    topicLessons().then((x) => x, (e) => `THREW: ${(e as Error).message}`),
    scriptLessons().then((x) => x, (e) => `THREW: ${(e as Error).message}`),
  ]);
  if (saved) process.env.DATABASE_URL = saved; else delete process.env.DATABASE_URL;
  check(tl === "" && sl === "", "#51 with the database unreachable, lessons are empty rather than an error", `topic="${tl.slice(0, 40)}" script="${sl.slice(0, 40)}"`);

  console.log("\nScenario 14 — a rejection becomes a usable instruction");
  const text = formatLessons([
    { stage: "topic.dropped", title: null, reason: '"The Pig War" (bureaucratic_absurdity) averaged 7.1 < 7.5; weakest axes: evidence 5, freshness 6', at: "Sep 21" },
    { stage: "script.below-bar", title: "The Chocolate River", reason: "forecast 7/10 after repairs (bar 7.5); weakest: clarity", at: "Sep 21" },
  ]);
  check(text.includes("evidence 5") && text.includes("weakest: clarity") && text.includes("The Chocolate River"),
    "#51 the reason, the weakest axis and the title all reach the prompt");
}

console.log(bad ? `\n❌ ${bad} behaviour(s) wrong.\n` : "\n✅ every replayed failure now behaves correctly.\n");
process.exitCode = bad ? 1 : 0;
export {};
