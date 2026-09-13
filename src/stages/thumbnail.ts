import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelConfig } from "../config";
import { sh } from "../lib/media";
import { commonsImage, nasaImage } from "../lib/sources";

const FONTS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",   // Linux / GitHub Actions
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",       // macOS
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial Bold.ttf",
];

let drawtext: boolean | undefined;
/** Some ffmpeg builds ship without libfreetype, so drawtext simply does not exist. */
async function hasDrawtext(): Promise<boolean> {
  if (drawtext === undefined) {
    drawtext = await sh("ffmpeg", ["-hide_banner", "-filters"]).then((o) => /^\s*\S+\s+drawtext\s/m.test(o), () => false);
    if (!drawtext) {
      console.warn('⚠️  This ffmpeg build has no "drawtext" filter, so thumbnail text cannot be burned in.');
      console.warn('   Fix on macOS:  brew uninstall ffmpeg && brew install ffmpeg   (then check: ffmpeg -filters | grep drawtext)');
      console.warn("   Continuing with a text-free thumbnail.");
    }
  }
  return drawtext;
}

async function firstFont(): Promise<string | null> {
  for (const f of FONTS) if (await fs.access(f).then(() => true, () => false)) return f;
  return null;
}

// Everyday words that may appear in thumbnail text without being in the script.
const COMMON = new Set(["the","a","an","and","or","but","of","in","on","to","for","with","from","by","at","is","was",
  "this","that","how","why","what","when","where","who","not","no","never","always","all","one","two","first","last",
  "new","old","big","huge","tiny","real","true","best","worst","most","more","less","problem","mystery","secret",
  "story","truth","reason","answer","question","inside","behind","before","after","almost","nearly","still","yet",
  "working","broken","missing","hidden","lost","found","built","made","saved","killed","changed","failed","fixed",
  "impossible","possible","simple","strange","wrong","right","safe","cost","price","years","days","ways"]);

/** Conservative stemmer: only strips a suffix when at least 4 characters remain. */
function stem(w: string): string {
  const x = w.toLowerCase();
  for (const suf of ["ies", "ing", "ed", "es", "s"]) {
    if (x.endsWith(suf) && x.length - suf.length >= 4) return suf === "ies" ? `${x.slice(0, -3)}y` : x.slice(0, -suf.length);
  }
  return x;
}

/**
 * Thumbnail text must be words the script actually uses (or everyday words). This catches invented or
 * garbled text — "800 MILES UNBURNT" — before it is burned into an image nobody can edit afterwards.
 */
export function safeThumbnailText(proposed: string, title: string, narration: string): string {
  const vocab = new Set((`${title} ${narration}`.toLowerCase().replace(/-/g, " ").match(/[a-z0-9']+/g) ?? []).map(stem));
  const words = proposed.match(/[A-Za-z0-9']+/g) ?? [];
  const known = (w: string) => /^[0-9]/.test(w) || w.length <= 3 || COMMON.has(w.toLowerCase()) || vocab.has(stem(w));
  if (words.length && words.every(known)) return proposed;

  // Rebuild from the title, keeping word order so it still reads like English.
  const t = title.match(/[A-Za-z0-9'-]+/g) ?? [];
  const keep = t.map((w) => w.replace(/-$/, ""))
    .filter((w) => /^[0-9]/.test(w) || (w.length > 4 && !COMMON.has(w.toLowerCase())));
  const built = keep.slice(0, 3).join(" ");
  return built || title.split(/\s+/).slice(0, 3).join(" ");
}

/** Wrap to at most 2 lines and shrink the font until the longest line fits inside the safe area. */
function fitText(text: string): { lines: string[]; fontsize: number } {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  let lines = [words.join(" ")];
  if (words.length > 2) {
    // split near the middle, on a word boundary
    let best = 1;
    let bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const diff = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    lines = [words.slice(0, best).join(" "), words.slice(best).join(" ")];
  }
  const longest = Math.max(...lines.map((l) => l.length));
  // DejaVu/Arial Bold caps average ~0.62 em wide; 1160px of usable width inside a 1280px frame.
  const fontsize = Math.max(44, Math.min(104, Math.floor(1160 / (longest * 0.62))));
  return { lines, fontsize };
}

const isVideoFile = (f: string) => /\.(mp4|mov|webm)$/i.test(f);

export async function makeThumbnail(cfg: ChannelConfig, query: string, text: string, dir: string, used: Set<string>, fallbackImage: string): Promise<string> {
  const raw = path.join(dir, "thumb-raw.jpg");
  let got = null;
  for (const find of cfg.imageSources.map((n) => (n === "nasa" ? nasaImage : commonsImage))) {
    got = await find(query, used, raw).catch(() => null);
    if (got && got.score >= 0.5) break;
  }
  const src = got ? raw : fallbackImage;
  const out = path.join(dir, "thumbnail.jpg");
  // A single JPEG from a video input needs -update 1; without it ffmpeg wants a %03d pattern and fails.
  const single = isVideoFile(src) ? ["-frames:v", "1", "-update", "1"] : [];
  // Fill the frame, lift contrast, darken the edges so the subject and the text both pop.
  const base = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720," +
    "eq=contrast=1.22:saturation=1.35:brightness=0.02,unsharp=5:5:0.8,vignette=PI/4.5";

  const font = await firstFont();
  if (await hasDrawtext() && font) {
    const { lines, fontsize } = fitText(text);
    const textFile = path.join(dir, "thumb-text.txt"); // a file avoids every drawtext escaping trap
    await fs.writeFile(textFile, lines.join("\n"));
    // line_spacing + centred x keeps both lines inside the frame at any length
    await sh("ffmpeg", ["-y", "-i", src, "-vf",
      `${base},drawtext=fontfile='${font}':textfile='${textFile}':fontsize=${fontsize}:line_spacing=12:` +
      `fontcolor=white:borderw=${Math.max(5, Math.round(fontsize / 12))}:bordercolor=black:x=(w-text_w)/2:y=h-text_h-64`,
      ...single, "-q:v", "3", out]);
  } else {
    if (!font) console.warn("⚠️  No bold system font found; thumbnail text skipped.");
    await sh("ffmpeg", ["-y", "-i", src, "-vf", base, ...single, "-q:v", "3", out]);
  }
  return out;
}
