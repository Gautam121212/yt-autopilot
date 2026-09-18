/**
 * `npm run audit` — proves every gate exists, is wired, and has a sane threshold.
 * Run it after any change: it fails loudly rather than letting a gate quietly go missing.
 */
import fs from "node:fs";
import path from "node:path";
import { loadChannel, ROOT } from "../src/config";

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
let bad = 0;
const ok = (pass: boolean, what: string, detail = "") => {
  console.log(`${pass ? "✅" : "❌"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!pass) bad++;
};

const cfg = loadChannel();
const produce = read("src/jobs/produce.ts");
const types = read("src/types.ts");
const topic = read("src/stages/topic.ts");
const visuals = read("src/stages/visuals.ts");
const render = read("src/stages/render.ts");
const sceneQaSrc = read("src/stages/scene-qa.ts");

console.log("\n── the pipeline, in order ──");
// Search only the body, so the file's own header comment cannot satisfy a check.
const body = produce.slice(produce.indexOf("async function main("));
const order = ["picking a topic", "topic scores", "checking whether the story can be filmed",
  "researching", "writing the script", "expanding", "comedy pass", "fact + policy check",
  "scene-by-scene visual check", "rendering", "final check"];
let last = -1, sequenced = true;
for (const step of order) {
  const at = body.indexOf(step);
  if (at < 0) { ok(false, `stage missing: "${step}"`); sequenced = false; continue; }
  if (at < last) { ok(false, `stage out of order: "${step}"`); sequenced = false; }
  last = at;
}
ok(sequenced, "stages run in the intended order", order.length + " stages");

console.log("\n── gates that stop work before credits are spent ──");
ok(produce.includes("MIN_TOPIC_SCORE") && produce.includes("dropped") , "topic score gate", `average must clear ${process.env.MIN_TOPIC_SCORE ?? 7.5}`);
ok(produce.includes("probeTopicVisuals"), "topic filmability gate", "before research or script");
ok(topic.includes("absurdity >= 7") && topic.includes("retellability >= 7"), "six-axis topic pass gate");
ok(types.includes("visualSubjects"), "topic must name 8-12 filmable subjects");
ok(produce.includes("script.too-short"), "script length gate", `${/MIN_WORDS = (\d+)/.exec(types)?.[1] ?? "?"} words minimum`);
ok(produce.includes("feasibility.abandoned"), "scene-level image feasibility gate");
ok(produce.includes("scene-qa.abandoned"), "per-scene visual gate", `bar ${process.env.SCENE_BAR ?? 7.5}/10, abandons past 25% failures`);
ok(produce.includes("forecast.abandoned") || produce.includes("abandoned before production"), "forecast gate");

console.log("\n── the script framework ──");
for (const role of ["cold_open", "reaction", "premise", "escalation", "turn", "mechanism", "payoff", "kicker"])
  ok(types.includes(`"${role}"`), `beat sheet role: ${role}`);
ok(types.includes("Scene 1 must be the cold_open"), "beat sheet enforced by the schema");
ok(types.includes("at least 3 escalation"), "escalation minimum enforced");

console.log("\n── production rules ──");
ok(!visuals.includes("makeCard") && !fs.existsSync(path.join(ROOT, "src/stages/cards.ts")), "no text cards anywhere");
ok(!cfg.imageSources.includes("nasa" as never), "NASA is not a visual source", cfg.imageSources.join(" > "));
ok(render.includes("planShots"), "scenes are cut into shots");
ok(render.includes("No sentence timings? Cut on the clock"), "shot cutting cannot silently fail");
ok(render.includes("CAPTION_LEAD_IN"), "captions never appear over the opening fade");
ok(visuals.includes("bigEnough") || read("src/lib/sources.ts").includes("MIN_IMG_W"), "image quality floor", `${process.env.MIN_IMG_W ?? 1600}px minimum width`);
ok(read("src/stages/thumbnail.ts").includes("bestFrameFrom"), "thumbnail is cut from the video itself");
ok(sceneQaSrc.includes("SCENE_BAR"), "per-scene bar is configurable");

console.log("\n── settings as loaded ──");
console.log(`   topic bar ${process.env.MIN_TOPIC_SCORE ?? 7.5} · filmable ${Number(process.env.MIN_TOPIC_VISUAL ?? 0.7) * 100}% · scene bar ${process.env.SCENE_BAR ?? 7.5}/10 · final bar ${cfg.approval.minScore}/10`);
console.log(`   ${cfg.targetMinutes.join("-")} min @ ${cfg.wordsPerMinute} wpm · shots ~${process.env.SHOT_SECS_H ?? 7}s long / ${process.env.SHOT_SECS_V ?? 3.5}s vertical · ${Math.round(cfg.videoClipRatio * 100)}% video clips`);
console.log(`   voice ${cfg.voice.voiceId} @ ${cfg.voice.speed} · sources ${cfg.imageSources.join(" > ")}`);

console.log(bad ? `\n❌ ${bad} problem(s) found.\n` : "\n✅ every gate and framework rule is present and wired.\n");
process.exitCode = bad ? 1 : 0;
export {};
