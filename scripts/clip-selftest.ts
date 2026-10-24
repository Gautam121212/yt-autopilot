/**
 * Clipper selftest. Exercises everything in src/lib/yt-clipper.ts that doesn't require network:
 *   - parseVtt against a synthetic .vtt sample (including inline <timestamp> tags and dup lines)
 *   - transcriptForLlm chunking
 *   - formatCandidates rendering
 *
 * Deliberately avoids the live yt-dlp + LLM path — those are driven by `npm run clip -- <url>`
 * against a real video. Rate limits on YouTube's caption endpoints are what pushed this split.
 *
 * Run: `npm run clip:selftest`
 */
import { parseVtt, transcriptForLlm, formatCandidates, type VideoMeta, type ClipList } from "../src/lib/yt-clipper.js";

const SAMPLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:03.000
Welcome to the show,<00:00:01.080> we're going to talk about rockets.

00:00:03.000 --> 00:00:06.000
Welcome to the show, we're going to talk about rockets.

00:00:06.000 --> 00:00:10.000
First, let me ask: why are rockets so hard?

00:00:10.500 --> 00:00:14.000
The answer surprised me, and it's going to surprise you.

00:00:14.000 --> 00:00:19.000
Here's the thing nobody tells you about combustion chambers.
`;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function rec(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}: ${detail}`);
}

const cues = parseVtt(SAMPLE_VTT);
rec("parse: 4 unique cues (one dup dropped)", cues.length === 4, `got ${cues.length}`);
rec("parse: inline <ts> tags stripped", !cues[0]?.text.includes("<"), `first cue: "${cues[0]?.text}"`);
rec("parse: timestamps are seconds", cues[0]?.startSec === 0 && cues[1]?.startSec === 6, `[0,1]=${cues[0]?.startSec},${cues[1]?.startSec}`);

const transcript = transcriptForLlm(cues);
rec("transcript: has [MM:SS] marker", /\[00:00\]/.test(transcript), "contains [00:00]");
rec("transcript: contains caption text", transcript.includes("rockets"), "contains 'rockets'");

const fakeMeta: VideoMeta = { id: "test", title: "Why rockets are hard", uploader: "selftest", durationSec: 600 };
const fakeList: ClipList = { candidates: [
  { rank: 1, startSec: 10.5, endSec: 42, originalFirstLine: "Here's the thing nobody tells you", newFirstLine: "Rockets fail for one weird reason.", onScreenText: "The combustion secret", loopPoint: "it loops back to the question", framingNote: "fine for 9:16", rationale: "complete thought + turn + lands" },
]};
const out = formatCandidates(fakeMeta, fakeList);
rec("format: shows rank + hook", out.includes("#1") && out.includes("NEW hook"), "render shape ok");

const failed = checks.filter((c) => !c.ok);
if (failed.length) { console.error(`\n✗ ${failed.length}/${checks.length} failed`); process.exit(1); }
console.log(`\n✓ all ${checks.length} selftest checks passed`);
