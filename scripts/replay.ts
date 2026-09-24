/**
 * `npm run replay` — replays real production failures against the actual client with a fake
 * network, and checks behaviour rather than wording. Each scenario is a run that happened.
 */
import { z } from "zod";

const fs30 = await import("node:fs");
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

// ── Scenarios 15-19: the run on 21 Sep 20:00 — every scene 0-4/10, then a crash. ──
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { sceneQa } = await import("../src/stages/scene-qa");
  const { resetCandidateState } = await import("../src/lib/candidates");

  // Real image bytes so ffmpeg really builds the contact sheet.
  const tmp = fs.mkdtempSync("/tmp/replay-sel-");
  // Detailed images, not flat colour: a flat 1920px jpg compresses to 12 KB, under the floor that
  // (correctly) rejects truncated downloads, which made the first version of this test fail for
  // a reason that could never happen with real stock photos.
  const jpg = (w: number, h: number, tag: string) => {
    const f = path.join(tmp, `${tag}-${w}.jpg`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}`, "-frames:v", "1", f]);
    return fs.readFileSync(f);
  };
  const THUMB = jpg(640, 360, "thumb");
  const FULL = jpg(1920, 1080, "full");
  check(FULL.length > 20_000, "fixture: the full-size test image is as large as a real photo", `${FULL.length} bytes`);

  process.env.PEXELS_API_KEY = "test"; process.env.PIXABAY_API_KEY = "test";
  process.env.GEMINI_MIN_GAP_MS = "0";

  // One search returns 5 Pexels photos; ids are unique per query so dedupe can be observed.
  const pexelsSearch = (q: string) => ({ photos: Array.from({ length: 5 }, (_, k) => {
    const id = Math.abs([...q].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7)) % 100000 * 10 + k;
    return { id, width: 1920, alt: `${q} ${k}`, src: { medium: `https://thumbs.test/${id}.jpg`, large2x: `https://full.test/${id}.jpg` } };
  }) });
  let visionCalls = 0;
  let rankFor: (sheetSize: number) => unknown = () => ({ ranking: [{ n: 2, score: 8, why: "strong b-roll" }, { n: 1, score: 7, why: "ok" }, { n: 5, score: 6.5, why: "fine" }] });
  let failThumbs = new Set<string>();

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({ host: u.host });
    if (u.host === "api.pexels.com") return new Response(JSON.stringify(pexelsSearch(u.searchParams.get("query") ?? "")), { status: 200 });
    if (u.host === "pixabay.com") return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    if (u.host === "thumbs.test") return failThumbs.has(u.pathname) ? new Response("", { status: 404 }) : new Response(THUMB, { status: 200 });
    if (u.host === "full.test") return new Response(FULL, { status: 200 });
    if (u.host.includes("googleapis")) {
      visionCalls++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const hasImage = JSON.stringify(body).includes("inline_data");
      const text = JSON.stringify(hasImage ? rankFor(9) : {});
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] }), { status: 200 });
    }
    return new Response("not scripted", { status: 500 });
  }) as typeof fetch;

  const scene = (id: string, q: string) => ({ id, narration: `The cable ${id} whipped through the air.`, imageQuery: q,
    altQueries: [`${q} close`, "steel cable"], era: "modern", motion: "still" });
  const run = async (scenes: ReturnType<typeof scene>[], used = new Set<string>(), prefetched = true) => {
    const dir = fs.mkdtempSync(path.join(tmp, "run-"));
    const files = scenes.map((_, i) => {
      const f = path.join(dir, `orig-${i}.jpg`);
      if (prefetched) fs.writeFileSync(f, THUMB); // a real pooled image the scene already has
      return [f];
    });
    const credits = scenes.map(() => ({ source: "x", id: "x", title: "x" }));
    visionCalls = 0;
    const r = await sceneQa({ cfg: {} as never, dir, videoId: 1, used, scenes, files, credits });
    return { r, files, credits, used };
  };

  console.log("\nScenario 15 — a good option exists among the candidates: ONE vision call, three chosen shots");
  resetCandidateState(); calls = [];
  const s15 = await run([scene("sc01", "coiled steel cable")]);
  check(visionCalls === 1, "#55 one vision call per scene when the first sheet has a good shot", `${visionCalls} call(s)`);
  check(s15.r.passed === 1, "#55 the scene passes the bar with strong B-roll", `lead 8/10, passed ${s15.r.passed}`);
  check(s15.files[0]!.length === 3 && s15.files[0]!.every((f) => fs.existsSync(f) && fs.statSync(f).size > 1000),
    "#55 the scene's cuts are the three chosen shots, downloaded at full size", `${s15.files[0]!.length} files`);
  check(calls.filter((c) => c.host === "full.test").length === 3, "#55 only the chosen shots are downloaded at full size");

  console.log("\nScenario 16 — nothing on the first sheet is good enough: a second sheet from the editor's own suggestions");
  resetCandidateState(); calls = [];
  let round = 0;
  rankFor = () => (++round === 1
    ? { ranking: [{ n: 1, score: 4, why: "static pylons, not a whipping cable" }], suggestQueries: ["rope snapping slow motion", "whip crack"] }
    : { ranking: [{ n: 3, score: 8, why: "rope under tension, right action" }] });
  const s16 = await run([scene("sc06", "falling cable")]);
  check(visionCalls === 2, "#55 exactly two sheets, then it stops", `${visionCalls} call(s)`);
  check(s16.r.passed === 1, "#55 the editor's suggested searches find a shot that clears the bar");

  console.log("\nScenario 17 — the model names a shot that is not on the sheet");
  resetCandidateState(); calls = [];
  rankFor = () => ({ ranking: [{ n: 42, score: 9, why: "hallucinated" }, { n: 1, score: 7.8, why: "real" }] });
  const s17 = await run([scene("sc07", "copper wire")]).then((x) => x, (e) => ({ error: (e as Error).message }) as never);
  check(!("error" in s17) && s17.r.passed === 1 && s17.files[0]!.length >= 1,
    "#55 an out-of-range pick is ignored rather than crashing", "error" in s17 ? String((s17 as { error: string }).error).slice(0, 60) : "used shot 1");

  console.log("\nScenario 18 — thumbnails fail to download (the ENOENT crash in the 21 Sep run)");
  resetCandidateState(); calls = [];
  rankFor = () => ({ ranking: [{ n: 1, score: 8, why: "good" }] });
  failThumbs = new Set(Array.from({ length: 5 }, (_, k) => `/${Math.abs([..."broken glass"].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7)) % 100000 * 10 + k}.jpg`).slice(0, 3));
  const s18 = await run([scene("sc10", "broken glass")]).then((x) => x, (e) => ({ error: (e as Error).message }) as never);
  failThumbs = new Set();
  check(!("error" in s18), "#56 missing thumbnails are skipped, never an ENOENT", "error" in s18 ? String((s18 as { error: string }).error).slice(0, 70) : "sheet built from the rest");

  console.log("\nScenario 19 — two scenes asking for the same thing must not get the same shot");
  resetCandidateState(); calls = [];
  rankFor = () => ({ ranking: [{ n: 1, score: 8, why: "good" }] });
  const s19 = await run([scene("sc02", "steel cable"), scene("sc03", "steel cable")]);
  const keysUsed = [...s19.used].filter((k) => k.startsWith("pexels:"));
  check(s19.credits[0]!.id !== s19.credits[1]!.id, "#55 each scene gets its own shot", `${s19.credits[0]!.id} vs ${s19.credits[1]!.id}`);
  check(calls.filter((c) => c.host === "api.pexels.com").length <= 3, "#55 a repeated search is served from the run cache",
    `${calls.filter((c) => c.host === "api.pexels.com").length} Pexels searches for 2 identical scenes`);

  console.log("\nScenario 20 — the Short gets vertical footage, judged as the viewer will see it");
  resetCandidateState(); calls = [];
  const seenOrient: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.host === "api.pexels.com" || u.host === "pixabay.com") seenOrient.push(u.searchParams.get("orientation") ?? "?");
    return realFetch(url, init);
  }) as typeof fetch;
  rankFor = () => ({ ranking: [{ n: 1, score: 8, why: "good vertical" }] });
  const dir20 = fs.mkdtempSync(path.join(tmp, "short-"));
  const files20 = [[path.join(dir20, "orig.jpg")]];
  await sceneQa({ cfg: {} as never, dir: dir20, videoId: 1, used: new Set(), scenes: [scene("sh01", "steel cable")],
    files: files20, credits: [{ source: "x", id: "x", title: "x" }], orientation: "portrait" });
  globalThis.fetch = realFetch;
  check(seenOrient.includes("portrait") && seenOrient.includes("vertical"), "#59 Pexels asked for portrait, Pixabay for vertical",
    [...new Set(seenOrient)].join(", "));

  console.log("\nScenario 21 — Pexels is shared: once the run budget is spent, no stage can call it");
  const { takePexels, resetPexelsBudget } = await import("../src/lib/budget");
  resetPexelsBudget();
  let granted = 0;
  for (let k = 0; k < 400; k++) if (takePexels()) granted++;
  calls = [];
  const { pexelsImage } = await import("../src/lib/sources");
  const after = await pexelsImage("anything", new Set(), path.join(tmp, "x.jpg"));
  check(granted === Number(process.env.PEXELS_RUN_BUDGET ?? 150) && after === null && !calls.some((c) => c.host === "api.pexels.com"),
    "#60 the fetch stage respects the shared budget too", `${granted} granted, then no Pexels request`);
  resetPexelsBudget();

  console.log("\nScenario 22 — Gemini's quota runs out on scene 2 of 4");
  const { resetSelectionBudget } = await import("../src/stages/scene-qa");
  resetCandidateState(); resetSelectionBudget(); calls = [];
  let n22 = 0;
  const searched22: string[] = [];
  const realFetch22 = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.host === "api.pexels.com" || u.host === "pixabay.com") searched22.push(u.searchParams.get("query") ?? u.searchParams.get("q") ?? "");
    if (u.host.includes("googleapis") && ++n22 >= 2) {
      calls.push({ host: u.host });
      return new Response(JSON.stringify({ error: { code: 429, message: "Resource exhausted: quota" } }), { status: 429 });
    }
    return realFetch22(url, init);
  }) as typeof fetch;
  rankFor = () => ({ ranking: [{ n: 1, score: 8, why: "good" }] });
  const s22 = await run([scene("q1", "iron beam"), scene("q2", "rivet gun"), scene("q3", "crane hook"), scene("q4", "steel mill")], new Set(), true)
    .then((x) => x, (e) => ({ error: (e as Error).message }) as never);
  globalThis.fetch = realFetch22;
  const gemAfter = calls.filter((c) => c.host.includes("googleapis")).length;
  check(!("error" in s22), "#61 a quota wall mid-selection does not crash the run");
  if (!("error" in s22)) {
    check(s22.r.failed.length <= 1 && s22.r.unjudged.length >= 2,
      "#61 unjudged scenes are NOT counted as failures", `failed ${s22.r.failed.length}, unjudged ${s22.r.unjudged.length}`);
    // The refused calls all belong to the ONE request that hit the wall (the client's normal 429
    // backoff). What matters is that the scenes after it spent nothing at all.
    const later = searched22.filter((q) => /crane hook|steel mill/.test(q));
    check(later.length === 0, "#61 scenes after the quota wall spend nothing — no searches, no vision",
      `${later.length} searches for q3/q4; ${gemAfter} retries inside the one failing request`);
  }

  console.log("\nScenario 23 — the per-run vision budget protects the final check's quota");
  resetCandidateState(); resetSelectionBudget(); calls = [];
  process.env.SCENE_VISION_BUDGET = "2";
  // budget is read at module load, so re-import a fresh copy of the module
  const fresh = await import(`../src/stages/scene-qa.ts?b=${Date.now()}`) as typeof import("../src/stages/scene-qa");
  delete process.env.SCENE_VISION_BUDGET;
  visionCalls = 0;
  const dir23 = fs.mkdtempSync(path.join(tmp, "budget-"));
  const sc23 = [scene("b1", "gear wheel"), scene("b2", "pulley"), scene("b3", "lever arm"), scene("b4", "piston")];
  const r23 = await fresh.sceneQa({ cfg: {} as never, dir: dir23, videoId: 1, used: new Set(), scenes: sc23,
    files: sc23.map(() => [path.join(dir23, "o.jpg")]), credits: sc23.map(() => ({ source: "x", id: "x", title: "x" })) });
  check(visionCalls === 2 && r23.unjudged.length === 2, "#61 selection stops at its vision budget",
    `${visionCalls} vision calls, ${r23.unjudged.length} unjudged`);

  // ── Scenario 26: the run of 22 Sep 06:35 — every Gemini model overloaded, backup key refused. ──
  console.log("\nScenario 26 — Gemini overloaded on every model, backup provider returns 401 (22 Sep)");
  const { resetDeadProviders, isQuota: isQ } = await import("../src/lib/llm");
  resetCandidateState(); resetSelectionBudget(); resetDeadProviders(); calls = [];
  process.env.GEMINI_BUSY_WAIT1_MS = "20"; process.env.GEMINI_BUSY_WAIT2_MS = "20";
  process.env.OPENAI_COMPAT_BASE_URL = "https://compat.test/v1"; process.env.OPENAI_COMPAT_API_KEY = "dead";
  process.env.OPENAI_COMPAT_MODEL_HEAVY = "m"; process.env.OPENAI_COMPAT_MODEL_LIGHT = "m"; process.env.OPENAI_COMPAT_VISION = "true";
  const hits26 = { gemini: 0, compat: 0 };
  const realFetch26 = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.host.includes("googleapis")) {
      hits26.gemini++;
      return new Response(JSON.stringify({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }), { status: 503 });
    }
    if (u.host === "compat.test") {
      hits26.compat++;
      return new Response(JSON.stringify({ error: { message: "User not found.", code: 401 } }), { status: 401 });
    }
    return realFetch26(url, init);
  }) as typeof fetch;
  const sc26 = ["sc01", "sc02", "sc03", "sc04", "sc05", "sc06"].map((id) => scene(id, `${id} steel bridge`));
  const r26 = await run(sc26).then((x) => x, (e) => ({ error: (e as Error).message }) as never);
  globalThis.fetch = realFetch26;
  for (const k of ["OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_MODEL_HEAVY", "OPENAI_COMPAT_MODEL_LIGHT", "OPENAI_COMPAT_VISION", "GEMINI_BUSY_WAIT1_MS", "GEMINI_BUSY_WAIT2_MS"]) delete process.env[k];
  check(!("error" in r26), "#72 an outage does not crash the selection");
  if (!("error" in r26)) {
    check(r26.r.failed.length === 0, "#72 NOT ONE scene is counted as failed during an outage", `failed ${r26.r.failed.length}, unjudged ${r26.r.unjudged.length}`);
    check(r26.r.unjudged.length >= sc26.length - 1 && r26.r.failed.length === 0, "#72 scenes hit by the outage are unjudged (not failed), so the video pauses and resumes", `${r26.r.unjudged.length}/${sc26.length} unjudged, ${r26.r.failed.length} failed`);
    check(hits26.compat === 1, "#73 a refused key is called once, then disabled for the run", `${hits26.compat} call(s) to the dead provider`);
    check(hits26.gemini >= 3, "#72 overloaded Gemini is waited out and retried before giving up", `${hits26.gemini} Gemini attempts`);
  }

  console.log("\nScenario 27 — images must never reach a model that cannot see them");
  resetCandidateState(); resetSelectionBudget(); resetDeadProviders();
  process.env.OPENAI_COMPAT_BASE_URL = "https://compat.test/v1"; process.env.OPENAI_COMPAT_API_KEY = "k";
  process.env.OPENAI_COMPAT_MODEL_HEAVY = "m"; process.env.OPENAI_COMPAT_MODEL_LIGHT = "m";
  process.env.GEMINI_BUSY_WAIT1_MS = "10"; process.env.GEMINI_BUSY_WAIT2_MS = "10";
  let blindCalls = 0;
  const realFetch27 = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.host.includes("googleapis")) return new Response(JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }), { status: 503 });
    if (u.host === "compat.test") { blindCalls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"ranking":[{"n":1,"score":9,"why":"invented"}]}' }, finish_reason: "stop" }] }), { status: 200 }); }
    return realFetch27(url, init);
  }) as typeof fetch;
  const r27 = await run([scene("v1", "granite quarry")]);
  globalThis.fetch = realFetch27;
  for (const k of ["OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_MODEL_HEAVY", "OPENAI_COMPAT_MODEL_LIGHT", "GEMINI_BUSY_WAIT1_MS", "GEMINI_BUSY_WAIT2_MS"]) delete process.env[k];
  check(blindCalls === 0 && !r27.r.failed.includes("v1"), "#73 a text-only model is never asked to rank pictures; the scene gets library footage, not a failure", `${blindCalls} blind call(s); invented 9/10 not accepted`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Scenario 30: a vision-capable named provider can stand in for Gemini. ──
// Module tables (PROVIDER, NAMED, ROLE_PROVIDER) are read once at load, so a live end-to-end run of
// this needs a separate process; scripts/select-test.ts covers that against real Groq. Here we assert
// the ROUTING RULE that decides it, which is what regressed before: a vision call may go to a named
// provider only if that provider has a vision model, and the image must be sent.
{
  console.log("\nScenario 30 — the vision routing rule");
  const src30 = fs30.readFileSync(new URL("../src/lib/llm.ts", import.meta.url), "utf8");
  check(/vision\?: string/.test(src30), "#79 a named provider can declare a vision model");
  check(/vision: process\.env\.GROQ_MODEL_VISION/.test(src30), "#79 Groq ships a default free vision model");
  check(/needsSight \? orderAll\.filter\(\(n\) => NAMED\[n\]\?\.vision\)/.test(src30), "#79 a vision call routes only to providers that can see");
  check(/needsSightNamed \? usableNamed\.vision!/.test(src30), "#79 a vision call uses the provider vision model, and the image is passed");
  check(/if \(needImages && !nv\) continue;/.test(src30), "#79 in the fallback chain, a blind provider is skipped, never sent images");
}

// ── Scenario 33: a Gemini 403 (project denied) is reported as an account error, not "out of quota". ──
{
  console.log("\nScenario 33 — Gemini 403 PERMISSION_DENIED is surfaced, not mislabelled as quota");
  process.env.GEMINI_API_KEY = "x"; process.env.GEMINI_MODEL_LIGHT = "gt"; process.env.GEMINI_MIN_GAP_MS = "0";
  delete process.env.GROQ_API_KEY; delete process.env.ZAI_API_KEY;
  const llm33 = await import(`../src/lib/llm.ts?acct=${Date.now()}`) as typeof import("../src/lib/llm");
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 403, message: "Your project has been denied access. Please contact support.", status: "PERMISSION_DENIED" } }), { status: 403 })) as typeof fetch;
  const z33 = (await import("zod")).z;
  let msg = "";
  await llm33.askJson({ tier: "light", role: "judge", schema: z33.object({ ok: z33.boolean() }), system: "s", prompt: "p" }).catch((e) => { msg = (e as Error).message; });
  globalThis.fetch = saved;
  delete process.env.GEMINI_MIN_GAP_MS;
  check(/refused this project\/key|PERMISSION_DENIED/.test(msg) && /aistudio\.google\.com/.test(msg),
    "#83 a 403 tells the person to fix the key, not to wait for quota", msg ? msg.split("\n")[0]!.slice(0, 70) : "no error thrown");
  check(!/out of quota|midnight Pacific/.test(msg), "#83 a 403 is NOT reported as a quota/overload problem");
}

// ── Scenario 32: Groq is reached as a vision fallback even when LLM_ROLE_VISION is unset. ──
{
  console.log("\nScenario 32 — role unset (Gemini), Gemini down, Groq picks up the vision call");
  delete process.env.LLM_ROLE_VISION;
  process.env.GROQ_API_KEY = "gk"; process.env.GROQ_MODEL_VISION = "scout-vision";
  process.env.GEMINI_MIN_GAP_MS = "0"; process.env.GEMINI_API_KEY = "x"; process.env.GEMINI_MODEL_LIGHT = "gt";
  const llm32 = await import(`../src/lib/llm.ts?groqfb=${Date.now()}`) as typeof import("../src/lib/llm");
  const seen: { host: string; model?: string; img: boolean }[] = [];
  const saved = globalThis.fetch;
  const fs4 = await import("node:fs"); const os4 = await import("node:os"); const p4 = await import("node:path");
  const img = p4.join(os4.tmpdir(), "g.jpg"); fs4.writeFileSync(img, Buffer.from("ffd8ffe000104a464946", "hex"));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url); const b = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ host: u.host, model: b.model, img: JSON.stringify(b).includes("image_url") });
    if (u.host.includes("groq")) return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }), { status: 503 });
  }) as typeof fetch;
  const z32 = (await import("zod")).z;
  const ok32 = await llm32.askJson({ tier: "light", role: "vision", schema: z32.object({ ok: z32.boolean() }), system: "s", prompt: "p", images: [img] }).then(() => true, () => false);
  globalThis.fetch = saved;
  const g = seen.find((c) => c.host.includes("groq"));
  check(ok32 && !!g, "#82 Groq answers vision when Gemini is down, even with the role unset", g ? `groq model ${g.model}` : "groq NOT reached");
  check(!!g?.img && g?.model === "scout-vision", "#82 the image is sent, to Groq's vision model");
  for (const k of ["GROQ_API_KEY", "GROQ_MODEL_VISION", "GEMINI_MIN_GAP_MS"]) delete process.env[k];
}

// ── Scenario 31: visionOptional builds the video from library-ranked footage, held for approval. ──
{
  console.log("\nScenario 31 — vision fully down, visionOptional keeps the channel producing");
  const { resetSelectionBudget, sceneQa } = await import("../src/stages/scene-qa");
  const { resetCandidateState } = await import("../src/lib/candidates");
  const fs3 = await import("node:fs"); const path3 = await import("node:path");
  resetSelectionBudget(); resetCandidateState();
  const tmp = fs3.mkdtempSync("/tmp/replay-vo-");
  const { execFileSync } = await import("node:child_process");
  process.env.PEXELS_API_KEY = "t"; process.env.PIXABAY_API_KEY = "t"; process.env.GEMINI_MIN_GAP_MS = "0";
  const THUMB = (() => { const f = path3.join(tmp, "t.jpg"); execFileSync("ffmpeg", ["-v","error","-y","-f","lavfi","-i","testsrc2=size=640x360","-frames:v","1",f]); return fs3.readFileSync(f); })();
  const FULL = (() => { const f = path3.join(tmp, "f.jpg"); execFileSync("ffmpeg", ["-v","error","-y","-f","lavfi","-i","testsrc2=size=1920x1080","-frames:v","1",f]); return fs3.readFileSync(f); })();
  const saved3 = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.host === "api.pexels.com") return new Response(JSON.stringify({ photos: [{ id: Math.floor(Math.random()*1e6), width: 1920, alt: "steel", src: { medium: "https://t.test/a.jpg", large2x: "https://f.test/a.jpg" } }] }), { status: 200 });
    if (u.host === "pixabay.com") return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    if (u.host === "t.test") return new Response(THUMB, { status: 200 });
    if (u.host === "f.test") return new Response(FULL, { status: 200 });
    return new Response(JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } }), { status: 503 });
  }) as typeof fetch;
  const dir = fs3.mkdtempSync(path3.join(tmp, "vo-"));
  const scs = ["s1","s2","s3"].map((id) => ({ id, narration: `${id} steel cable whipping`, imageQuery: "steel cable", altQueries: ["rope"], motion: "still", era: "modern" }));
  const files = scs.map(() => [path3.join(dir, "o.jpg")]); const credits = scs.map(() => ({ source: "x", id: "x", title: "x" }));
  scs.forEach((_, i) => { files[i] = [path3.join(dir, `missing-${i}.jpg`)]; }); // nothing on disk yet
  const res = await sceneQa({ cfg: {} as never, dir, videoId: 1, used: new Set(), scenes: scs, files, credits });
  globalThis.fetch = saved3;
  for (const k of ["PEXELS_API_KEY","PIXABAY_API_KEY","GEMINI_MIN_GAP_MS"]) delete process.env[k];
  check(res.autoPicked.length === 3, "#80 every scene gets library-ranked footage when vision is down", `${res.autoPicked.length}/3 auto-picked`);
  check(res.failed.length === 0, "#80 not one scene is counted as failed");
  check(files.every((f) => f.length >= 1 && f[0]!.includes("sel-") && fs3.existsSync(f[0]!)), "#80 real footage was downloaded for each scene");
  fs3.rmSync(tmp, { recursive: true, force: true });
}

// ── Scenario 28: outages must never become lessons; real rejections must. ──
{
  console.log("\nScenario 28 — the learning loop keeps content lessons and drops outages");
  const { INFRA } = await import("../src/lib/lessons");
  const re = new RegExp(INFRA, "i");
  const outage = ["POST x/chat/completions -> 401: User not found", "13/13 scenes below 7.5 — Every model is overloaded", "Resource exhausted: quota", "The operation was aborted due to timeout"];
  const content = ['"The Pig War" averaged 7.1 < 7.5; weakest axes: evidence 5', "forecast 7/10 after repairs; weakest: clarity", "only 40% filmable; no stock footage for: 1888 ledger"];
  check(outage.every((m) => re.test(m)), "#74 outage messages are excluded from lessons", `${outage.filter((m) => re.test(m)).length}/${outage.length} excluded`);
  check(content.every((m) => !re.test(m)), "#74 real content lessons still reach the writer and picker", `${content.filter((m) => !re.test(m)).length}/${content.length} kept`);
}

// ── Scenario 29: a sloppy but complete script must be normalised, not thrown away. ──
{
  console.log("\nScenario 29 — a model answer with the formatting mistakes that cost heavy calls");
  const { ScriptSchema } = await import("../src/types");
  const sc = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, role,
    narration: "Word ".repeat(80).trim() + ".", imageQuery: "steel cable", altQueries: ["rope"], motion: "Video", era: "Ancient",
    cardHeadline: "THREE HUNDRED AND FORTY METRES PER SECOND OF CABLE", cardSub: "x", claimIds: [], ...extra });
  const sloppy = {
    title: "t", altTitles: ["a", "b", "c", "d"], description: "d", tags: Array.from({ length: 22 }, (_, i) => `tag${i}`),
    thumbnailText: "HE CRACKED THE SOUND BARRIER WITH A ROPE", thumbnailQuery: "q", claims: [],
    short: { title: "s", scenes: [sc("s1", "Cold Open"), sc("s2", "premise"), sc("s3", "kicker")] },
    scenes: [sc("a", "cold open"), sc("b", "reaction"), sc("c", "premise"), sc("d", "Escalation"), sc("e", "escalation"),
      sc("f", "escalation"), sc("g", "twist"), sc("h", "mechanism"), sc("i", "payoff"), sc("j", "kicker")],
  };
  const r = ScriptSchema.safeParse(sloppy);
  check(r.success, "#75 formatting mistakes are normalised instead of rejected", r.success ? "parsed" : r.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (r.success) {
    const d = r.data;
    check(d.altTitles.length === 3 && d.tags.length === 15, "#75 4 titles -> 3, 22 tags -> 15", `${d.altTitles.length} titles, ${d.tags.length} tags`);
    check(d.scenes[0]!.role === "cold_open" && d.scenes[6]!.role === "turn" && d.scenes[0]!.motion === "clip" && d.scenes[0]!.era === "historical",
      "#75 'cold open' / 'twist' / 'Video' / 'Ancient' mapped to real values", `${d.scenes[0]!.role}, ${d.scenes[6]!.role}, ${d.scenes[0]!.motion}, ${d.scenes[0]!.era}`);
    check(d.scenes[0]!.cardHeadline.length <= 40 && !/\s$/.test(d.scenes[0]!.cardHeadline), "#75 long captions cut at a word boundary", `"${d.scenes[0]!.cardHeadline}"`);
    check(d.scenes[0]!.altQueries.length >= 2 && d.short.scenes[1]!.role === "escalation", "#75 one alt query padded; unknown Short role mapped", `${d.scenes[0]!.altQueries.length} queries, short role ${d.short.scenes[1]!.role}`);
  }
}

// ── Scenario 25: the run of 21 Sep 20:44 — stuck 38 minutes in the footage pool. ──
{
  console.log("\nScenario 25 — every stock search answers slowly, as on 21 Sep");
  process.env.POOL_BUDGET_MS = "1500";
  process.env.PEXELS_API_KEY = "test"; process.env.PIXABAY_API_KEY = "test";
  const { resetPexelsBudget } = await import("../src/lib/budget");
  resetPexelsBudget();
  const { fetchPool } = await import(`../src/stages/visuals.ts?pool=${Date.now()}`) as typeof import("../src/stages/visuals");
  const { loadChannel } = await import("../src/config");
  const saved = globalThis.fetch;
  let slowCalls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    slowCalls++;
    // 20 s per call, the way retries and slow downloads added up on the real run; honours abort.
    return new Promise<Response>((res, rej) => {
      const t = setTimeout(() => res(new Response(JSON.stringify({ photos: [], hits: [] }), { status: 200 })), 20_000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
    });
  }) as typeof fetch;
  const t0 = Date.now();
  const fs = await import("node:fs");
  const pool = await fetchPool(loadChannel(), new Set(), fs.mkdtempSync("/tmp/replay-pool-"), ["steam valve", "rusty gear"]);
  const took = Date.now() - t0;
  globalThis.fetch = saved;
  delete process.env.POOL_BUDGET_MS;
  check(took < 4_000, "#64 the pool stops at its limit instead of running for 38 minutes", `${(took / 1000).toFixed(1)}s with every search taking 20s`);
  check(Array.isArray(pool), "#64 the phase continues with whatever arrived", `${pool.length} spare(s)`);
}

// ── Scenario 24: the preflight must fail safe, never crash the run it is protecting. ──
{
  console.log("\nScenario 24 — YouTube credentials missing");
  const { checkUploadAuth } = await import("../src/lib/youtube");
  const saved = { a: process.env.YT_CLIENT_ID, b: process.env.YT_CLIENT_SECRET, c: process.env.YT_REFRESH_TOKEN };
  delete process.env.YT_CLIENT_ID; delete process.env.YT_CLIENT_SECRET; delete process.env.YT_REFRESH_TOKEN;
  const r = await checkUploadAuth().then((x) => x, (e) => ({ ok: false, reason: `THREW ${(e as Error).message}` }));
  Object.assign(process.env, Object.fromEntries(Object.entries({ YT_CLIENT_ID: saved.a, YT_CLIENT_SECRET: saved.b, YT_REFRESH_TOKEN: saved.c }).filter(([, v]) => v)));
  check(!r.ok && !("reason" in r && String(r.reason).startsWith("THREW")), "#62 missing credentials are reported, not thrown",
    "reason" in r ? String(r.reason).slice(0, 70) : "");
}

console.log(bad ? `\n❌ ${bad} behaviour(s) wrong.\n` : "\n✅ every replayed failure now behaves correctly.\n");
process.exitCode = bad ? 1 : 0;
export {};
