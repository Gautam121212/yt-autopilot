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
// One restrained palette so every card in a video looks like it came from the same designer.
const PALETTE = [
  ["0x0b1d2a", "0x16394f"], ["0x141a2e", "0x2b3558"], ["0x0f2318", "0x1f4a33"],
  ["0x241310", "0x4a2820"], ["0x101822", "0x2b3a4a"],
];
const ACCENT = "0xE8B44A"; // warm gold, used only as a rule and a keyline

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
export async function makeCard(o: {
  headline: string; sub?: string; index: number; width: number; height: number; out: string;
  /** "title" for the opening card, "chapter" for section breaks, "fact" for the default figure card */
  kind?: "title" | "chapter" | "fact";
  /** small label in the corner, e.g. the channel name */
  label?: string;
}): Promise<string> {
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

  const kind = o.kind ?? "fact";
  const tall = headLines.length > 2;                       // long titles need the rule out of their way
  const ruleW = Math.round(o.width * (kind === "title" ? 0.22 : 0.10));
  const ruleY = Math.round(o.height * (tall ? 0.80 : o.sub ? 0.60 : 0.58));
  const pad = Math.round(o.width * 0.06);

  const filters = [
    `gradients=s=${o.width}x${o.height}:c0=${a}:c1=${b}:x0=0:y0=0:x1=${o.width}:y1=${o.height}:d=1`,
    `drawgrid=w=${Math.round(o.width / 18)}:h=${Math.round(o.width / 18)}:t=1:c=white@0.035`,
    `vignette=PI/4.5`,
    // a single accent rule under the headline does more for "designed" than any amount of decoration
    `drawbox=x=(iw-${ruleW})/2:y=${ruleY}:w=${ruleW}:h=${Math.max(3, Math.round(o.height / 240))}:color=${ACCENT}@0.95:t=fill`,
  ];
  if (f) {
    const headY = tall
      ? `${Math.round(o.height * 0.18)}`
      : o.sub ? `(h-text_h)/2-${Math.round(o.height * 0.09)}` : `(h-text_h)/2-${Math.round(o.height * 0.04)}`;
    filters.push(`drawtext=fontfile='${f}':textfile='${headFile}':fontsize=${headSize}:line_spacing=18:fontcolor=white:` +
      `shadowcolor=black@0.55:shadowx=0:shadowy=3:x=(w-text_w)/2:y=${headY}`);
    if (o.sub) {
      await fs.writeFile(subFile, wrap(o.sub, 42).join("\n"));
      filters.push(`drawtext=fontfile='${f}':textfile='${subFile}':fontsize=${Math.round(o.width / 38)}:line_spacing=12:` +
        `fontcolor=white@0.78:x=(w-text_w)/2:y=${ruleY + Math.round(o.height * 0.055)}`);
    }
    if (o.label) {
      filters.push(`drawtext=fontfile='${f}':text='${o.label.replace(/[':\\]/g, "")}':fontsize=${Math.round(o.width / 62)}:` +
        `fontcolor=${ACCENT}@0.85:x=${pad}:y=${pad}`);
    }
  }

  await sh("ffmpeg", ["-y", "-f", "lavfi", "-i", filters.join(","), "-frames:v", "1", "-update", "1", "-q:v", "2", o.out]);
  await fs.rm(headFile, { force: true });
  await fs.rm(subFile, { force: true });
  return o.out;
}
