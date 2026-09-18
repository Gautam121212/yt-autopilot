/**
 * `npm run voice:sample` — renders the SAME funny line in several Kokoro voices and speeds,
 * then opens them. You pick what sounds like a person telling a story, not a narrator.
 * Whatever you choose goes in config/channel.json -> voice.voiceId / voice.speed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadChannel, ROOT } from "../src/config";
import { sh } from "../src/lib/media";
import { synthesize } from "../src/stages/voice";

const LINE = "So he drank it. On purpose. Nobody stopped him, which tells you most of what you need to know about 1822.";

// Kokoro's American and British voices, graded best-first by the model's own voice list.
const OPTIONS: { voice: string; speed: number; note: string }[] = [
  { voice: "af_heart", speed: 0.95, note: "current — warm, measured" },
  { voice: "af_heart", speed: 1.05, note: "current, quicker — less narrator-ish" },
  { voice: "af_bella", speed: 1.0, note: "brighter, more conversational" },
  { voice: "am_michael", speed: 1.0, note: "male, dry" },
  { voice: "am_fenrir", speed: 1.05, note: "male, livelier" },
  { voice: "bm_george", speed: 1.0, note: "British male, deadpan" },
  { voice: "bf_emma", speed: 1.0, note: "British female, wry" },
];

const cfg = loadChannel();
const dir = path.join(ROOT, "work", "voice-samples");
await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });

const made: string[] = [];
for (const [i, o] of OPTIONS.entries()) {
  process.stdout.write(`${i + 1}/${OPTIONS.length}  ${o.voice} @ ${o.speed}  (${o.note}) ... `);
  try {
    const out = await synthesize({ ...cfg, voice: { ...cfg.voice, provider: "kokoro", voiceId: o.voice, speed: o.speed } },
      [{ id: `v${i}`, narration: LINE }], path.join(dir, o.voice + "-" + o.speed));
    const named = path.join(dir, `${String(i + 1).padStart(2, "0")}-${o.voice}-${o.speed}.wav`);
    await fs.copyFile(out[0]!.file, named);
    made.push(named);
    console.log("ok");
  } catch (e) {
    console.log(`failed: ${(e as Error).message.slice(0, 60)}`);
  }
}

if (made.length) {
  console.log(`\n${made.length} samples in ${dir}`);
  console.log("Listen, then set your pick in config/channel.json:\n  \"voice\": { \"provider\": \"kokoro\", \"voiceId\": \"<pick>\", \"speed\": <pick>, \"model\": \"onnx-community/Kokoro-82M-v1.0-ONNX\" }");
  await sh("open", [dir]).catch(() => {});
}
export {};
