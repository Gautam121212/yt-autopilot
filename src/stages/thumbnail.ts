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

export async function makeThumbnail(cfg: ChannelConfig, query: string, text: string, dir: string, used: Set<string>, fallbackImage: string): Promise<string> {
  const raw = path.join(dir, "thumb-raw.jpg");
  let got = null;
  for (const find of cfg.imageSources.map((n) => (n === "nasa" ? nasaImage : commonsImage))) {
    got = await find(query, used, raw).catch(() => null);
    if (got && got.score >= 0.5) break;
  }
  const src = got ? raw : fallbackImage;
  const out = path.join(dir, "thumbnail.jpg");
  const base = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=contrast=1.15:saturation=1.25";

  const font = await firstFont();
  if (await hasDrawtext() && font) {
    const { lines, fontsize } = fitText(text);
    const textFile = path.join(dir, "thumb-text.txt"); // a file avoids every drawtext escaping trap
    await fs.writeFile(textFile, lines.join("\n"));
    // line_spacing + centred x keeps both lines inside the frame at any length
    await sh("ffmpeg", ["-y", "-i", src, "-vf",
      `${base},drawtext=fontfile='${font}':textfile='${textFile}':fontsize=${fontsize}:line_spacing=12:` +
      `fontcolor=white:borderw=${Math.max(5, Math.round(fontsize / 12))}:bordercolor=black:x=(w-text_w)/2:y=h-text_h-64`,
      "-q:v", "3", out]);
  } else {
    if (!font) console.warn("⚠️  No bold system font found; thumbnail text skipped.");
    await sh("ffmpeg", ["-y", "-i", src, "-vf", base, "-q:v", "3", out]);
  }
  return out;
}
