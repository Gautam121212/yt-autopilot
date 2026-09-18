/**
 * `npm run voice:sample` — renders the SAME line in four voices so you can pick with your ears.
 * Loads the model once, one short line per voice, with a per-voice timeout so it cannot hang.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { KokoroTTS } from "kokoro-js";
import { loadChannel, ROOT } from "../src/config";
import { sh } from "../src/lib/media";
import { withTimeout } from "../src/lib/time";

const LINE = "So he drank it. On purpose. Nobody stopped him, which tells you most of what you need to know about 1822.";

const OPTIONS: { voice: string; speed: number; note: string }[] = [
  { voice: "af_heart", speed: 1.05, note: "current voice, quicker — less narrator" },
  { voice: "am_michael", speed: 1.0, note: "male, dry" },
  { voice: "bm_george", speed: 1.0, note: "British male, deadpan" },
  { voice: "af_bella", speed: 1.05, note: "female, conversational" },
];

const cfg = loadChannel();
const dir = path.join(ROOT, "work", "voice-samples");
await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });

console.log("loading Kokoro (first run downloads ~90 MB) ...");
const tts = await withTimeout(
  KokoroTTS.from_pretrained(cfg.voice.model, { dtype: "q8", device: "cpu", progress_callback: undefined as never }),
  10 * 60_000, "Kokoro model load",
);
console.log("loaded.\n");

const made: string[] = [];
for (const [i, o] of OPTIONS.entries()) {
  process.stdout.write(`${i + 1}/${OPTIONS.length}  ${o.voice} @ ${o.speed}  (${o.note}) ... `);
  try {
    const audio = await withTimeout(
      tts.generate(LINE, { voice: o.voice as "af_heart", speed: o.speed }),
      3 * 60_000, `${o.voice}`,
    );
    const out = path.join(dir, `${i + 1}-${o.voice}-${o.speed}.wav`);
    await audio.save(out);
    made.push(out);
    console.log("ok");
  } catch (e) {
    console.log(`failed: ${(e as Error).message.slice(0, 70)}`);
  }
}

if (!made.length) {
  console.log("\nNo samples were produced. Run `npm run voice` first to check Kokoro works at all.");
} else {
  console.log(`\n${made.length} samples in ${dir}`);
  for (const f of made) console.log(`  ${path.basename(f)}`);
  console.log(`\nListen, then put your pick in config/channel.json:`);
  console.log(`  "voice": { "provider": "kokoro", "voiceId": "<id>", "speed": <speed>, "model": "${cfg.voice.model}" }`);
  await sh("open", [dir]).catch(() => {});
}
export {};
