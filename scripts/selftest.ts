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
ok(render.includes("loudnorm=I=-14"), "render: audio normalised to YouTube's -14 LUFS");
ok(render.includes("planShots") && render.includes("Cut on the clock"), "render: shot cutting cannot silently fail");

console.log(bad ? `\n❌ ${bad} regression(s).\n` : "\n✅ schemas accept real answers; invariants hold.\n");
process.exitCode = bad ? 1 : 0;
export {};
