/**
 * `npm run selftest` — parses real-world-shaped model answers against every schema, and checks the
 * invariants that past fixes have broken. Catches a regression in ~2 seconds, before a run does.
 */
import { loadChannel } from "../src/config";
import { DossierSchema, ScriptSchema, TopicSchema, scriptWords, MIN_WORDS } from "../src/types";

let bad = 0;
const ok = (pass: boolean, what: string, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!pass) bad++;
};

// ── schemas must accept the shapes models actually return ────────────────────────────────
const topic = {
  candidates: [] as unknown[],
  chosen: {
    workingTitle: "The Train That Needed to Balance Its Cows", subject: "s", angle: "a", hook: "h",
    mentalModel: "m", demandEvidence: "d",
    funniestDetail: "They weighed the cows individually.",
    premise: "A railway had to weigh livestock to stop carriages tipping over.",
    visualSubjects: ["cattle wagon", "rail yard", "old scales", "steam locomotive", "livestock pen", "iron rails"],
    scores: { absurdity: 9, retellability: 9, curiosity: 8, evidence: 9, illustratability: 8, freshness: 8 },
    wikipediaQueries: ["cattle transport rail", "livestock wagon"],
  },
  rejected: [],
};
topic.candidates = [topic.chosen];
ok(TopicSchema.safeParse(topic).success, "topic: realistic answer parses");

const dossierBase = {
  summary: "s",
  sources: [{ id: "S1", url: "https://en.wikipedia.org/wiki/x", title: "t" }, { id: "S2", url: "https://en.wikipedia.org/wiki/y", title: "u" }],
  keyFacts: Array.from({ length: 8 }, () => ({ fact: "f", sourceIds: ["S1"] })),
  figures: [], mentalModel: "m",
  details: Array.from({ length: 6 }, () => ({ detail: "d", sourceIds: ["S1"] })),
};
ok(DossierSchema.safeParse({ ...dossierBase, uncertain: ["a doubt"] }).success, "dossier: uncertain as strings");
ok(DossierSchema.safeParse({ ...dossierBase, uncertain: [{ claim: "c", why: "w" }] }).success, "dossier: uncertain as objects (the crash you hit)");
ok(DossierSchema.safeParse({ ...dossierBase, uncertain: [] }).success, "dossier: uncertain empty");
ok(!DossierSchema.safeParse({ ...dossierBase, details: [], uncertain: [] }).success, "dossier: rejects a dossier with no narrative colour");

const scene = (role: string, i: number, words = 80) => ({
  id: `sc${i}`, role, narration: Array(words).fill("word").join(" "),
  imageQuery: "cattle wagon", altQueries: ["rail yard", "old scales"],
  motion: "clip", era: "any", cardHeadline: "H", cardSub: "s", claimIds: [],
});
const roles = ["cold_open", "reaction", "premise", "escalation", "escalation", "escalation", "turn", "mechanism", "payoff", "escalation", "mechanism", "escalation", "kicker"];
const shortScenes = ["cold_open", "escalation", "kicker"].map((r, i) => ({
  id: `sh${i}`, role: r, narration: "n", imageQuery: "cattle wagon", altQueries: ["rail yard", "old scales"],
  motion: "clip", era: "any", cardHeadline: "H", cardSub: "s",
}));
const script = {
  title: "t", altTitles: ["a", "b", "c"], description: "d", tags: [], thumbnailText: "THEY WEIGHED THE COWS",
  thumbnailQuery: "cattle wagon", claims: [], short: { title: "s", scenes: shortScenes },
  scenes: roles.map((r, i) => scene(r, i)),
};
ok(ScriptSchema.safeParse(script).success, "script: valid beat sheet parses");
ok(!ScriptSchema.safeParse({ ...script, scenes: roles.map((_, i) => scene("escalation", i)) }).success, "script: rejects a missing beat sheet");
ok(scriptWords(script) >= MIN_WORDS, "script: word counter agrees with the length gate", `${scriptWords(script)} words`);

// ── invariants that fixes have broken before ─────────────────────────────────────────────
const cfg = loadChannel();
ok(!cfg.imageSources.includes("nasa" as never), "config: NASA is not a visual source", cfg.imageSources.join(" > "));
ok(cfg.approval.uploadHeldVideos === false, "config: held videos are never uploaded");
ok(cfg.videosPerDay >= 1 && !!cfg.productionTimezone, "config: daily target + timezone set", `${cfg.videosPerDay}/day in ${cfg.productionTimezone}`);
ok(cfg.subNiches.length >= 10, "config: topic variety", `${cfg.subNiches.length} sub-niches`);
ok(cfg.targetMinutes[0] * cfg.wordsPerMinute >= MIN_WORDS, "config: length target agrees with MIN_WORDS");
// The two rules that disagreed: minimum scenes x minimum words must clear the length gate.
ok(13 * 78 >= MIN_WORDS, "schema: min scenes x min words clears the length gate", `13 x 78 = ${13 * 78} >= ${MIN_WORDS}`);

// ── things past fixes have broken, asserted from the source ──────────────────────────────
import fsSync from "node:fs";
import pathSync from "node:path";
import { ROOT as ROOT2 } from "../src/config";
const src = (p: string) => fsSync.readFileSync(pathSync.join(ROOT2, p), "utf8");
const llm = src("src/lib/llm.ts");
const research = src("src/stages/research.ts");
const render = src("src/stages/render.ts");

ok(llm.includes("GEMINI_OUTPUT_CAP") && llm.includes("thinkingConfig"), "llm: output capped at the real limit and thinking budgeted");
ok(llm.includes("thinking disabled") || llm.includes("thinkBudget"), "llm: MAX_TOKENS retries by disabling thinking, not by shrinking the answer");
ok(research.includes("20000"), "research: input stays rich (quality was not traded for the token fix)");
ok(src("src/types.ts").includes('detail: z.string(), sourceIds: z.array(z.string()).min(1) })).min(6)'),
  "research: still demands 6 sourced narrative details");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
ok(count(render, "loudnorm") === 1, "render: loudness applied exactly once", `${count(render, "loudnorm")} pass(es)`);
ok(count(render, "sidechaincompress") === 1, "render: music ducked exactly once", `${count(render, "sidechaincompress")} pass(es)`);
ok(count(render, "async function pickMusic") === 1, "render: one music picker, not two");
ok(render.includes("loudnorm=I=-14"), "render: audio normalised to YouTube's -14 LUFS");
ok(render.includes("MUSIC_GAIN"), "render: music level is configurable");
ok(render.includes("planShots") && render.includes("Cut on the clock"), "render: shot cutting cannot silently fail");

// ── registry guards (BUGS.md) ────────────────────────────────────────────────────────────
const produce = src("src/jobs/produce.ts");
const workflow = src(".github/workflows/produce.yml");
const feas = src("src/stages/feasibility.ts");
const visuals = src("src/stages/visuals.ts");

ok(llm.includes("fallbackChain"), "#20 fallback chain exists (not a single backup provider)");
ok(llm.includes("LLM_TIMEOUT_LIGHT") && llm.includes("LLM_TIMEOUT_HEAVY"), "#9 per-tier timeouts");
ok(!/cron:\s*"0\s/.test(workflow), "#15 no cron at minute 0 (GitHub drops those)");
ok(feas.includes("FINDABLE") && !feas.includes("const GOOD"), "#6 one shared findability threshold");
ok(visuals.includes("sourceNamesFor") && !visuals.includes('!(era === "historical" && n === "pexels")'), "#6 era orders sources, never drops them");
ok(produce.includes("productionTimezone"), "#8 daily quota counted in the channel's timezone");
ok(produce.includes("worthUploading"), "#final gate: nothing uploaded below the bar");
// #37 the CLI must not claim an upload it cannot verify.
const cloud = src("scripts/cloud.sh");
ok(!/echo "✅ Uploaded\./.test(cloud) && cloud.includes("youtube_id"),
  "#37 the finish message reports the real outcome, not just a clean exit");
ok(count(render, "pickMusic(o.seed)") >= 1, "#14 music picker is actually called");

// #22 role routing: every stage must declare which model does its job, and the split must be sane.
const stageRole: Record<string, string> = {
  "topic.ts": "gate", "feasibility.ts": "gate",
  // The footage selector looks at pixels, so it is vision — it was mislabelled "gate" before #55.
  "scene-qa.ts": "vision",
  "research.ts": "write",
  "verify.ts": "judge", "forecast.ts": "judge",
  // These two look at pixels, so they belong to vision, not judge (#41).
  "review.ts": "vision", "image-qa.ts": "vision",
};
for (const [file, role] of Object.entries(stageRole)) {
  ok(src(`src/stages/${file}`).includes(`role: "${role}"`), `#22 ${file} routes to "${role}"`);
}
ok(llm.includes("ROLE_PROVIDER") && llm.includes("NAMED"), "#22 role routing is wired in the client");
ok(!llm.includes('"mistral-large-latest"'), "#25 no paid Mistral model as a free-tier default");
// #29 anything github.sh pushes as a secret must be READ as a secret by the workflow.
const ghsh = src("scripts/github.sh");
const pushesEnvSecrets = /LLM_ROLE|MISTRAL/.test(ghsh) || ghsh.includes("while read");
for (const key of ["LLM_ROLE_GATE", "LLM_ROLE_WRITE", "LLM_ROLE_JUDGE", "MISTRAL_MODEL_HEAVY"]) {
  const line = workflow.split("\n").find((l) => l.trim().startsWith(`${key}:`)) ?? "";
  ok(!pushesEnvSecrets || line.includes("secrets."), `#29 workflow reads ${key} from secrets, not just vars`);
}
ok(llm.includes('o.role === "write" ? 0'), "#27 writing passes disable thinking so the output fits");
ok(llm.includes("paceFor("), "#33 calls to a provider are paced against its rate limit");
ok(llm.includes("cerebras") && llm.includes("zai") && llm.includes("nvidia") && llm.includes("openrouter"),
  "#39 several free providers are configured, not one");
// Every provider in the client must be testable, or a broken key is only discovered mid-run.
{
  const checker = src("scripts/check-providers.ts");
  const names = ["mistral", "zai", "groq", "cerebras", "nvidia", "openrouter"];
  ok(names.every((n) => checker.includes(`name: "${n}"`)), "#40 every provider is covered by `npm run providers`");
}
ok(llm.includes("trying ${nextName}") || llm.includes("for (const nextName of order"),
  "#39 a failing provider tries the next before Gemini");
ok(produce.includes("rewriting from scratch"), "#38 the script bar rewrites, not just repairs");
{
  const sel = src("src/stages/scene-qa.ts");
  ok(sel.includes("contactSheet") && sel.includes("gatherCandidates"), "#55 footage is chosen from a sheet of candidates, not judged one at a time");
  ok(sel.includes("B-ROLL") && !sel.includes("merely \"not wrong\" is a 5"), "#55 the rubric asks for B-roll, not a literal depiction stock cannot provide");
  ok(!sel.includes("async function preview("), "#56 no preview step that can ENOENT on a clip shorter than its seek");
  ok(!produce.includes("sc.imageQuery = approved[k % approved.length]"), "#57 a scene's own search is never overwritten round-robin");
  ok(!src("src/lib/candidates.ts").includes("relevance("), "#55 candidates keep the library's ranking, not caption word-overlap");
  const review = src("src/stages/review.ts");
  ok(!review.includes("any image does not depict what its narration says") && review.includes("B-roll"),
    "#59 the final check judges footage by the same B-roll standard as the selector");
  ok(!review.includes("NASA"), "#59 the final check no longer tells the reviewer the footage is NASA's");
  ok(produce.includes('orientation: "portrait"'), "#59 the Short's footage is chosen in portrait");
  // #62 preflight: the upload credential is checked BEFORE the first model call.
  const preAt = produce.indexOf("checkUploadAuth()");
  const topicAt = produce.indexOf('log("picking a topic');
  ok(preAt > 0 && preAt < topicAt, "#62 the YouTube credential is checked before any credit is spent");
  // #61 vision exhaustion defers the video instead of abandoning it, and does not burn attempts.
  ok(produce.includes("scene-select.deferred") && produce.includes("qa.unjudged.length > script.scenes.length / 2"),
    "#61 a video short of vision quota is paused and resumed, not abandoned");
  ok(produce.includes("waiting for vision quota"), "#61 a paused video is not retried every hour");
  ok(src("package.json").includes("select:test"), "#63 a real-API selection test exists");
  const vis = src("src/stages/visuals.ts");
  ok(vis.indexOf("const phaseStart = Date.now()") < vis.indexOf("await fetchPool("), "#64 the phase clock starts before the pool, so the pool counts against it");
  ok(vis.includes("POOL_BUDGET_MS") && /withBudget\(\s*mapLimit\(poolQueries/.test(vis), "#64 the pool has its own time limit");
  ok(/withTimeout\(Promise\.all\(\[\s*sceneImages/.test(produce), "#64 the whole footage + voice phase has a hard ceiling");
  ok(!produce.includes("images (NASA)"), "#65 no stale NASA text in the run log");
  // #66 bitrate ceiling on every x264 encode
  const rend = src("src/stages/render.ts");
  ok(count(rend, '"libx264"') === count(rend, '"-maxrate", MAXRATE'), "#66 every video encode has the bitrate ceiling",
    `${count(rend, '"-maxrate", MAXRATE')}/${count(rend, '"libx264"')} encodes capped`);
  // #67 chapters come from the beat sheet and obey YouTube's rules
  const pub = src("src/stages/publish.ts");
  ok(pub.includes("export function buildChapters") && !pub.includes('chapters.unshift("0:00 Intro")'),
    "#67 chapters are built from the beat sheet, never a lone '0:00 Intro'");
  // #68 no prompt may describe the deleted text cards or NASA footage
  const prompts = ["src/stages/forecast.ts", "src/stages/review.ts", "src/stages/script.ts", "src/types.ts"].map(src).join("\n");
  ok(!/typographic card|designed card|shown as a designed/.test(prompts), "#68 no prompt describes the deleted text cards");
  ok(!/Pexels and NASA|against Wikimedia Commons/.test(prompts), "#68 no prompt claims NASA or Commons-only footage");
  // #69 the ENOENT class: ffmpeg outputs are checked on disk before use
  ok(src("src/stages/thumbnail.ts").includes("fs.stat(out)"), "#69 thumbnail frames are checked on disk, not by exit code");
  {
    // Anchored to the style string itself — an unanchored pattern matched a comment quoting the old value.
    const mv = Number(/Alignment=2,MarginV=(\d+)/.exec(rend)?.[1] ?? 0);
    ok(mv >= 70 && mv <= 110, "#71 Short captions sit above YouTube's bottom UI overlay", `MarginV ${mv}/288 (~${Math.round((mv / 288) * 100)}% up)`);
  }
  // #70 research-backed writer changes
  const w = src("src/stages/script.ts");
  ok(w.includes("roadmap") && w.includes("LOOP"), "#70 the writer adds a payoff roadmap and loops the Short");
  // #72 a judgement that ERRORS is unjudged, never failed
  const selSrc = src("src/stages/scene-qa.ts");
  ok(selSrc.includes('"error" in pick') && selSrc.includes("could not be judged"), "#72 an outage marks scenes unjudged, not failed");
  // #73 refused keys are switched off; pictures never go to a blind model; the true cause is reported
  ok(llm.includes("deadProviders.add") && llm.includes("isAuthError"), "#73 a refused key is disabled for the rest of the run");
  ok(llm.includes("(o.images?.length ?? 0) > 0 && !seesImages) throw e"), "#73 images never reach a model that cannot see");
  ok(llm.includes("Fallbacks also failed"), "#73 a failed fallback reports the original capacity error, not its own 401");
  ok(llm.includes("await gemini(model, system, prompt, maxTokens, images, timeoutMs, thinkBudget)"),
    "#73 Gemini actually receives its timeout and thinking budget");
  ok(llm.includes("isOverload") && llm.includes("GEMINI_BUSY_WAIT1_MS"), "#73 overloads are waited out; quota is not");
  // #74 the lesson loop
  const les = src("src/lib/lessons.ts");
  ok(les.includes("i.message !~*") && /TOPIC_STAGES = \[[^\]]*scene-qa\.abandoned/.test(les) && !/SCRIPT_STAGES = \[[^\]]*scene-qa/.test(les),
    "#74 footage failures teach topic choice, outages teach nothing");
  // #75 normalise, don't reject
  const ty = src("src/types.ts");
  ok(!ty.includes(".length(3)") && !ty.includes("z.array(z.string()).max(15)") && ty.includes("enumish("),
    "#75 formatting mistakes are normalised, not rejected");
  // #77 Gemini unavailable at the final check: save the render, resume there — never reject, never re-render
  const firstDefer = produce.indexOf("await savePendingRender({");
  const repairLoop = produce.indexOf('while (review.decision === "hold"');
  ok(firstDefer > 0 && firstDefer < repairLoop, "#77 an unavailable final check saves the render BEFORE the repair loop can run");
  ok(/if \(reviewUnavailable\) break;/.test(produce) && count(produce, "await savePendingRender({") >= 3,
    "#77 Gemini failing mid-repair, or again on resume, also saves rather than rejects");
  ok(count(produce, "await finishAfterReview({") === 2 && count(produce, "const worthUploading") === 1,
    "#77 one shared post-review path for normal and resumed videos (no duplicated upload gate)");
  ok(produce.indexOf('if (stage === "rendered")') < produce.indexOf('if (stage === "verified")'),
    "#77 a saved render is resumed before anything else in the queue");
  ok(/status in \('planned','researched','scripted','verified','rendered','uploaded'\)/.test(produce),
    "#77 the queue picks up videos waiting at the final check");
  ok(produce.includes("the saved render is no longer available") && produce.includes('status: (stage = "verified")'),
    "#77 an expired render falls back to re-rendering the kept script, never to losing it");
  {
    const wf = src(".github/workflows/produce.yml");
    const produceAt = wf.indexOf("npm run produce");
    const saveAt = wf.indexOf("name: Save a finished render awaiting its final check");
    ok(saveAt > produceAt && /hashFiles\('work\/pending\/\*\*'\)/.test(wf) && /path: work\/pending\//.test(wf),
      "#77 the workflow uploads work/pending/ right after produce");
    ok(/actions: read/.test(wf), "#77 the workflow may download the artifact a previous run saved");
    ok(src("src/config.ts").includes('WORK = path.join(ROOT, "work")') && produce.includes('path.join(WORK, "pending"'),
      "#77 the code writes to exactly the folder the workflow uploads");
  }
}
{
  // #51 the failure cap: it must count crashes only. Rejections are the design, not waste.
  // Anchored to the `wasted` variable: an unanchored pattern matched the "shipped this week" query
  // first and reported the wrong thing.
  const capQuery = /n: wasted \}\] = await q[^"]*"select count\(\*\)::int as n from videos where created_at > now\(\) - interval '([^']+)' and status (= '[a-z]+'|in \([^)]+\))/s.exec(produce);
  ok(!!capQuery && capQuery[2] === "= 'failed'", "#51 the waste cap counts crashes only, never rejections",
    capQuery ? `status ${capQuery[2]} over ${capQuery[1]}` : "query not found");
  ok(produce.includes('incident("topic.dropped"') && produce.includes('incident("topic.unfilmable"'),
    "#51 topic rejections are recorded, so they can be learned from");
  ok(src("src/stages/topic.ts").includes("await topicLessons()"), "#51 the topic picker reads recent rejections");
  ok(src("src/stages/script.ts").includes("await scriptLessons()"), "#51 the writer reads recent rejections");
  // #52 quality over length, and the upload bar
  ok(MIN_WORDS === 750, "#52 a good 5-minute script is accepted", `MIN_WORDS ${MIN_WORDS}`);
  ok(cfg.approval.minScore === 7, "#53 nothing reaches YouTube below 7.0", `bar ${cfg.approval.minScore}`);
}
{
  // #50 Parse the role table out of the writer's own prompt and add up its MINIMUM scene count.
  // Two rules that disagreed by construction (a table allowing 11, a schema demanding 13) cost
  // three heavy calls a run; this asserts the arithmetic between them directly.
  const prompt = src("src/stages/script.ts");
  const rows = [...prompt.matchAll(/^\s{2}(cold_open|reaction|premise|escalation|turn|mechanism|payoff|kicker)\s+(\d+)(?:-(\d+))?\s/gm)];
  const minSum = rows.reduce((n, m) => n + Number(m[2]), 0);
  const { TARGET_SCENES: target, MIN_SCHEMA_SCENES: floor } = await import("../src/types");
  ok(rows.length === 8, "#50 the writer's role table lists all eight beats", `${rows.length} rows`);
  ok(minSum >= target, "#50 the role table's minimum reaches the scene target", `table min ${minSum} >= target ${target}`);
  ok(floor < target, "#50 the schema accepts salvageable scripts below the target", `schema min ${floor}, target ${target}`);
  ok(count(prompt, "return normaliseSceneCount(await askJson") >= 6, "#50 every script-producing pass is normalised");
}
// #41 only the two stages that look at pixels may claim the vision role.
ok(src("src/stages/review.ts").includes('role: "vision"') && src("src/stages/image-qa.ts").includes('role: "vision"'),
  "#41 image QA and the final check are routed to vision");
ok(src("src/stages/verify.ts").includes('role: "judge"') && src("src/stages/forecast.ts").includes('role: "judge"'),
  "#41 text-only judging does not consume the vision provider");
ok(llm.includes("needsSight"), "#41 a call carrying images is never routed to a text-only provider");
ok(!llm.includes('"llama-3.1-8b-instant"'), "#42 no defaults pointing at retired models");
{
  const verifySrc = src("src/stages/verify.ts");
  ok(verifySrc.includes("BLOCKING_CATEGORIES") && verifySrc.includes("OUT OF SCOPE"),
    "#47 the fact checker is scoped to facts and policy");
  ok(!/verdict: v\.verdict/.test(verifySrc) && verifySrc.includes("factualBlocker"),
    "#47 the verdict is derived from the issues, not taken from the model");
  // Every category the prompt could plausibly use must parse, or the call retries for nothing.
  const t = src("src/types.ts");
  ok(t.includes('"tone"') && t.includes("z.preprocess"), "#48 the verifier schema accepts the categories models use");
}
// Exactly one pacing mechanism per provider — two would double every gap and halve throughput.
ok(count(llm, "lastGemini = Date.now()") === 1 && count(llm, "lastCallAt.set") === 1,
  "#35 one pacer per provider, not two");
{
  // Count call sites that pass a fixed size versus the shrinking budget — a number would go stale
  // every time a provider is added, which is exactly what just happened.
  const fixed = count(llm, "body, o.maxTokens ?? 16000");
  const budgeted = count(llm, "Math.min(budget, o.maxTokens");
  ok(budgeted >= 3 && fixed === 1,
    "#34 every routed/fallback call honours the shrinking budget",
    `${budgeted} budgeted, ${fixed} fixed (the single-provider legacy path)`);
}
ok(!llm.includes('"mistral-large-latest"') && llm.includes("mistral-large-2512"),
  "#32 Mistral defaults are dated ids, not aliases");
ok(!produce.includes('todaysWins >= cfg.videosPerDay && !isDryRun() && process.env.FORCE_PRODUCE'),
  "#28 the daily target is not bypassed by FORCE");
const scriptTxt = src("src/stages/script.ts");
ok(scriptTxt.includes("words each") && scriptTxt.includes("mechanism"), "#26 script brief gives a per-role word budget");
const scriptSrc = src("src/stages/script.ts");
ok(count(scriptSrc, 'role: "write"') >= 3 && count(scriptSrc, 'role: "judge"') >= 3,
  "#22 script.ts: writing passes write, repair passes judge");
// #23 the script bar must sit before rendering, not after.
ok(produce.includes("script.below-bar") && produce.indexOf("script.below-bar") < produce.indexOf("#${video.id} rendering"),
  "#23 script bar sits before rendering");

console.log(bad ? `\n❌ ${bad} regression(s).\n` : "\n✅ schemas accept real answers; invariants hold.\n");
process.exitCode = bad ? 1 : 0;
export {};
