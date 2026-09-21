/**
 * `npm run select:test` — runs the REAL footage selector against the REAL stock libraries and the
 * REAL vision model, on three scenes taken from runs that scored 0-4/10 before the redesign.
 *
 * The replay suite proves the mechanics with a scripted model; only this proves the judgement. It
 * saves every contact sheet and every chosen shot into ./select-test/ so you can open them and see
 * exactly what the editor saw and what it picked. Costs about 3-6 vision calls; spends no LLM writing.
 */
import fs from "node:fs";
import path from "node:path";
import { loadChannel } from "../src/config";
import { sceneQa, SCENE_BAR } from "../src/stages/scene-qa";

process.env.KEEP_SHEETS = "true"; // read at call time, so setting it here is enough
const OUT = path.resolve("select-test");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Lines taken from the 21 Sep run, where the old selector scored every one of them 0-4/10.
const scenes = [
  { id: "sc06", era: "modern", motion: "clip",
    narration: "The cable, now moving faster than sound, whipped through the air and the tip cracked like a rifle shot.",
    imageQuery: "steel cable tension", altQueries: ["whip crack slow motion", "rope snapping"] },
  { id: "sc09", era: "any", motion: "still",
    narration: "Engineers measured the shockwave the way you would measure anything that embarrasses you: carefully, and several times.",
    imageQuery: "laboratory measuring instrument", altQueries: ["oscilloscope screen", "engineer notebook"] },
  { id: "sc10", era: "historical", motion: "still",
    narration: "Nobody was hurt, which the incident report describes, with some disappointment, as 'fortunate'.",
    imageQuery: "old typewritten report", altQueries: ["archive paper stamp", "filing cabinet"] },
];

const missing = ["GEMINI_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY"].filter((k) => !process.env[k]);
if (missing.length) {
  console.log(`❌ missing ${missing.join(", ")} in .env — this test needs the real services.`);
  process.exit(1);
}

const cfg = loadChannel();
const files = scenes.map(() => [path.join(OUT, "none.jpg")]);
const credits = scenes.map(() => ({ source: "none", id: "none", title: "none" }));
const t0 = Date.now();
const r = await sceneQa({ cfg, dir: OUT, videoId: 0, used: new Set(), scenes, files, credits });

console.log(`\n── result (${((Date.now() - t0) / 1000).toFixed(0)}s) ──`);
for (const [i, s] of scenes.entries()) {
  const verdict = r.failed.includes(s.id) ? "❌ below bar" : r.unjudged.includes(s.id) ? "⚠️ unjudged" : "✅ cleared";
  console.log(`${s.id}  ${verdict}  ${files[i]!.length} shot(s)  ${credits[i]!.title.slice(0, 60)}`);
}
console.log(`\n${r.passed}/${scenes.length} cleared ${SCENE_BAR}/10 · ${r.failed.length} below · ${r.unjudged.length} unjudged`);
console.log(`Saved in ${OUT}: sheet-*.jpg (what the editor saw) and sel-*.jpg/mp4 (what it chose). Open them.`);
console.log(r.passed >= 2
  ? "\n✅ The selector finds usable B-roll on real footage. Safe to run the full pipeline."
  : "\n⚠️ Fewer than 2 of 3 cleared. Read the 'why' lines above: they say whether the searches or the bar is the problem.");
process.exitCode = r.passed >= 2 ? 0 : 1;
export {};
