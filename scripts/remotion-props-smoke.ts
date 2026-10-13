/**
 * Phase 2 smoke test for the adapter. Feeds a minimal fake Script through buildExplainerProps,
 * asserts the shape matches ExplainerProps, writes the JSON to work/remotion-props-smoke/props.json
 * for manual inspection. Does NOT render — that's a Phase 3 integration test.
 *
 * Usage: `npm run adapter:smoke`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildExplainerProps, type ExplainerProps } from "../src/stages/remotion-props";
import type { Script, SceneTiming } from "../src/types";
import type { SceneAudio } from "../src/stages/voice";

const OUT_DIR = path.join(process.cwd(), "work", "remotion-props-smoke");
mkdirSync(OUT_DIR, { recursive: true });

const script = {
  title: "Why phone numbers used to be letters",
  altTitles: ["", "", ""],
  description: "A fake script for the smoke test.",
  tags: [],
  thumbnailText: "LETTERS", thumbnailQuery: "rotary phone",
  scenes: [
    { id: "sc01", role: "cold_open", narration: "A rotary phone dialed letters, not numbers. For eighty years, that was the rule.", imageQuery: "rotary phone", altQueries: [], motion: "still", era: "historical", cardHeadline: "1878", cardSub: "First exchange", claimIds: [] },
    { id: "sc02", role: "escalation", narration: "The letters mapped to numbers. KL5 meant 555. Nobody questioned it.", imageQuery: "telephone exchange", altQueries: [], motion: "still", era: "historical", cardHeadline: "", cardSub: "", claimIds: [] },
    { id: "sc03", role: "payoff", narration: "Then area codes outgrew the alphabet, and the letters quietly disappeared.", imageQuery: "modern phone", altQueries: [], motion: "clip", era: "modern", cardHeadline: "", cardSub: "", claimIds: [] },
  ],
  claims: [],
  short: { title: "", scenes: [] },
} as unknown as Script;

const audios: SceneAudio[] = [
  { sceneId: "sc01", file: "/tmp/fake-sc01.wav", duration: 7.5, segments: [{ text: "A rotary phone dialed letters, not numbers.", start: 0, end: 3.5 }, { text: "For eighty years, that was the rule.", start: 3.5, end: 7.5 }] },
  { sceneId: "sc02", file: "/tmp/fake-sc02.wav", duration: 5.0, segments: [{ text: "The letters mapped to numbers.", start: 0, end: 2 }, { text: "KL5 meant 555. Nobody questioned it.", start: 2, end: 5 }] },
  { sceneId: "sc03", file: "/tmp/fake-sc03.wav", duration: 6.0, segments: [{ text: "Then area codes outgrew the alphabet, and the letters quietly disappeared.", start: 0, end: 6 }] },
];

const timings: SceneTiming[] = [
  { sceneId: "sc01", start: 0, end: 7.5, speechSec: 7.5 },
  { sceneId: "sc02", start: 7.5, end: 12.5, speechSec: 5.0 },
  { sceneId: "sc03", start: 12.5, end: 18.5, speechSec: 6.0 },
];

const sceneAssets: string[][] = [
  ["/tmp/fake-asset-sc01-0.jpg", "/tmp/fake-asset-sc01-1.jpg"],
  ["/tmp/fake-asset-sc02-0.jpg"],
  ["/tmp/fake-asset-sc03-0.mp4"], // ← video file; adapter should NOT add ken-burns to it
];

const props = buildExplainerProps({
  script,
  audios,
  timings,
  sceneAssets,
  narrationFile: "/tmp/fake-narration.wav",
  musicFile: "/tmp/fake-music.mp3",
  shotTargetSec: 4,
});

// Structural assertions — the Remotion render dies with cryptic errors if the shape is wrong, so
// catching regressions here saves a lot of head-scratching later.
function die(msg: string): never { console.error(`✗ ${msg}`); process.exit(1); }
function expect(cond: boolean, msg: string) { if (!cond) die(msg); }

expect(props.theme === "clean-professional", "theme should default to clean-professional");
expect(Array.isArray(props.cuts) && props.cuts.length > 0, "cuts should be a non-empty array");
expect(props.cuts.every((c) => c.in_seconds < c.out_seconds), "every cut must have in_seconds < out_seconds");
expect(props.cuts.every((c) => typeof c.source === "string" && c.source.startsWith("/")), "sources should be absolute paths");

const videoCut = props.cuts.find((c) => c.source.endsWith(".mp4"));
expect(!!videoCut && videoCut.animation === undefined, "video sources should NOT get ken-burns");
const imgCut = props.cuts.find((c) => c.source.endsWith(".jpg"));
expect(!!imgCut && imgCut.animation === "ken-burns", "image sources SHOULD get ken-burns");

const firstCut = props.cuts[0]!;
expect(firstCut.transition_in === "fade", "first cut of each scene should fade in");
const lastCutOfScene1 = [...props.cuts].reverse().find((c) => c.id.startsWith("sc01-"))!;
expect(lastCutOfScene1.transition_out === "fade", "last cut of each scene should fade out");

expect(Array.isArray(props.overlays) && props.overlays!.length === 1, "exactly one scene has a cardHeadline so overlays should have one entry");
expect(props.overlays![0]!.text === "1878", "overlay text should be the cardHeadline");

expect(Array.isArray(props.captions) && props.captions!.length > 10, "captions should contain word-level entries");
expect(props.captions!.every((w) => w.startMs < w.endMs), "every caption word must have startMs < endMs");

expect(!!props.audio?.narration?.src, "narration audio src must be set");
expect(!!props.audio?.music?.src, "music audio src must be set when musicFile is provided");

const outFile = path.join(OUT_DIR, "props.json");
writeFileSync(outFile, JSON.stringify(props, null, 2));

console.log("✓ adapter smoke test passed");
console.log(`  cuts: ${props.cuts.length}`);
console.log(`  overlays: ${props.overlays?.length ?? 0}`);
console.log(`  captions: ${props.captions?.length ?? 0} words`);
console.log(`  wrote: ${outFile}`);
