/**
 * `npm run music:make` — synthesises three documentary-style ambient beds with ffmpeg.
 *
 * No download, no licence question: these are generated tones, so nothing is copyrighted and
 * nothing needs attribution. They are deliberately plain — a low sustained chord under a filter,
 * the "room tone" a documentary sits on — because a bed with a melody fights the narration.
 * Replace them with real tracks from the YouTube Audio Library whenever you like; anything in
 * assets/music/ is picked up automatically.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../src/config";
import { sh } from "../src/lib/media";

const DIR = path.join(ROOT, "assets", "music");
const SECS = Number(process.env.MUSIC_SECS ?? 240);

// Root notes a fifth apart, each with its fifth and octave: a stable open chord, no third, so it
// reads as neither major nor minor — which is what keeps it neutral under any narration.
const BEDS = [
  { name: "bed-low-c", root: 65.41, tag: "steady, serious" },     // C2
  { name: "bed-low-g", root: 49.00, tag: "darker, heavier" },     // G1
  { name: "bed-low-a", root: 55.00, tag: "warmer, lighter" },     // A1
];

await fs.mkdir(DIR, { recursive: true });

for (const b of BEDS) {
  const out = path.join(DIR, `${b.name}.wav`);
  const notes = [b.root, b.root * 1.5, b.root * 2, b.root * 3];
  // Each partial gets a slightly different slow tremolo so the chord breathes instead of buzzing.
  // tremolo's slowest rate is 0.1 Hz, which is still fast enough to sound like a pulse. apulsator
  // goes far slower, so the chord drifts rather than throbs.
  const srcs = notes.map((f, i) =>
    `sine=frequency=${f.toFixed(2)}:duration=${SECS}[n${i}];` +
    `[n${i}]apulsator=hz=${(0.03 + i * 0.011).toFixed(3)}:amount=0.30,volume=${(0.5 / (i + 1)).toFixed(3)}[v${i}]`).join(";");
  const mix = notes.map((_, i) => `[v${i}]`).join("");

  await sh("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `anoisesrc=d=${SECS}:c=pink:a=0.015`,
    "-filter_complex",
    `${srcs};${mix}amix=inputs=${notes.length}:normalize=0[chord];` +
    // lowpass removes anything that would compete with speech; the reverb-ish delay softens edges
    `[chord]lowpass=f=520,aecho=0.8:0.85:60:0.25[warm];` +
    `[0:a]lowpass=f=2000,volume=0.6[air];` +
    `[warm][air]amix=inputs=2:normalize=0,` +
    `afade=t=in:st=0:d=6,afade=t=out:st=${SECS - 8}:d=8,` +
    // normalise so MUSIC_GAIN means the same thing for a generated bed and a downloaded track
    `loudnorm=I=-20:TP=-3:LRA=7[a]`,
    "-map", "[a]", "-ac", "2", "-ar", "48000", out,
  ]);
  const size = (await fs.stat(out)).size;
  console.log(`  ${b.name}.wav  ${(size / 1e6).toFixed(1)} MB  — ${b.tag}`);
}

console.log(`\n${BEDS.length} beds written to assets/music/`);
console.log("They are mixed at MUSIC_GAIN (0.10) and ducked under the voice automatically.");
console.log("Prefer real music? Drop files from studio.youtube.com → Audio library into the same folder.");
export {};
