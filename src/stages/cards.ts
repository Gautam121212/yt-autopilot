/**
 * Generated visual cards.
 *
 * Some scenes simply have no honest photograph — a number, a comparison, a process, an abstraction.
 * Hunting the archive for those produces the pocket watches and bluebell forests. A card built from
 * the scene's own words is always relevant, always licence-clean, and looks deliberate.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { sh } from "../lib/media";

const FONTS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
];
const PALETTE = [
  ["0x0b1d2a", "0x16394f"], ["0x1a1230", "0x38265c"], ["0x0f2318", "0x1f4a33"],
  ["0x2a1410", "0x5a2a1e"], ["0x101822", "0x2b3a4a"],
];

async function font(): Promise<string | null> {
  for (const f of FONTS) if (await fs.access(f).then(() => true, () => false)) return f;
  return null;
}

/** Wrap text to a target line length without breaking words. */
function wrap(text: string, perLine: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    if ((line + " " + w).trim().length > perLine && line) { out.push(line); line = w; } else line = (line + " " + w).trim();
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}

/**
 * Renders a card: a big figure or phrase, an optional supporting line, on a graded background
 * with a faint grid. Returns the image path.
 */
export async function makeCard(o: { headline: string; sub?: string; index: number; width: number; height: number; out: string }): Promise<string> {
  const f = await font();
  const [a, b] = PALETTE[o.index % PALETTE.length]!;
  const dir = path.dirname(o.out);
  const headFile = path.join(dir, `card-${o.index}-head.txt`);
  const subFile = path.join(dir, `card-${o.index}-sub.txt`);

  const isFigure = /^[^a-zA-Z]*[0-9]/.test(o.headline) && o.headline.length <= 18;
  const headLines = wrap(o.headline.toUpperCase(), isFigure ? 18 : 22);
  // 0.72 of the frame, and 0.62 em per bold cap: measured, not guessed.
  const headSize = Math.max(48, Math.min(isFigure ? 170 : 110, Math.floor((o.width * 0.72) / (Math.max(...headLines.map((l) => l.length)) * 0.62))));
  await fs.writeFile(headFile, headLines.join("\n"));

  const filters = [
    `gradients=s=${o.width}x${o.height}:c0=${a}:c1=${b}:x0=0:y0=0:x1=${o.width}:y1=${o.height}:d=1`,
    `drawgrid=w=${Math.round(o.width / 16)}:h=${Math.round(o.width / 16)}:t=1:c=white@0.05`,
  ];
  if (f) {
    filters.push(`drawtext=fontfile='${f}':textfile='${headFile}':fontsize=${headSize}:line_spacing=16:fontcolor=white:` +
      `x=(w-text_w)/2:y=(h-text_h)/2-${o.sub ? Math.round(o.height * 0.05) : 0}`);
    if (o.sub) {
      await fs.writeFile(subFile, wrap(o.sub, 44).join("\n"));
      filters.push(`drawtext=fontfile='${f}':textfile='${subFile}':fontsize=${Math.round(o.width / 34)}:line_spacing=10:` +
        `fontcolor=white@0.72:x=(w-text_w)/2:y=h/2+${Math.round(o.height * 0.14)}`);
    }
  }

  await sh("ffmpeg", ["-y", "-f", "lavfi", "-i", filters.join(","), "-frames:v", "1", "-update", "1", "-q:v", "2", o.out]);
  await fs.rm(headFile, { force: true });
  await fs.rm(subFile, { force: true });
  return o.out;
}
