/**
 * Looks at the images BEFORE rendering and replaces the bad ones.
 * Catches what metadata filters cannot: a logo painted on a rocket, a watermark, a crowd of people,
 * a photo that simply has nothing to do with the narration.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChannelConfig } from "../config";
import { askJson, providerSupportsVision } from "../lib/llm";
import { sh } from "../lib/media";
import { incident, log } from "../lib/log";
import type { ImageCredit } from "./visuals";
import { replaceSceneImage } from "./visuals";

const QaSchema = z.object({
  rejects: z.array(z.object({
    index: z.number().int().min(1),
    reason: z.enum(["logo_or_trademark", "identifiable_people", "watermark_or_text", "irrelevant", "low_quality"]),
    note: z.string(),
  })),
});

const SHEET = 12;   // images per contact sheet
const TW = 420, TH = 236, COLS = 4;

/**
 * Builds a numbered grid from the images.
 * Each image is a separate input, scaled and padded to an identical tile, then stacked — the concat
 * approach this replaced produced blank tiles, which made the reviewer reject everything.
 */
async function sheet(files: string[], out: string, labels = true) {
  const cols = Math.min(COLS, files.length);
  const rows = Math.ceil(files.length / cols);
  const filler = cols * rows - files.length;

  const inputs = files.flatMap((f) => ["-i", f]);
  for (let i = 0; i < filler; i++) inputs.push("-f", "lavfi", "-i", `color=c=black:s=${TW}x${TH}`);

  const parts: string[] = [];
  const tiles: string[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const label = labels && i < files.length
      ? `,drawbox=x=0:y=0:w=54:h=34:color=black@0.8:t=fill,drawtext=text='${i + 1}':fontcolor=white:fontsize=26:x=16:y=4`
      : "";
    parts.push(`[${i}:v]scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${label}[t${i}]`);
    tiles.push(`[t${i}]`);
  }
  for (let r = 0; r < rows; r++) {
    parts.push(`${tiles.slice(r * cols, (r + 1) * cols).join("")}hstack=inputs=${cols}[r${r}]`);
  }
  parts.push(rows > 1 ? `${Array.from({ length: rows }, (_, r) => `[r${r}]`).join("")}vstack=inputs=${rows}[out]` : `[r0]null[out]`);

  await sh("ffmpeg", ["-y", ...inputs, "-filter_complex", parts.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "3", out])
    .catch(async (e) => {
      // Some ffmpeg builds lack drawtext; retry without the numbers rather than failing QA entirely.
      if (!labels) throw e;
      await sheet(files, out, false);
    });
}

/**
 * Up to `rounds` passes: show the model the images, replace whatever it rejects, look again.
 * Returns the (possibly rewritten) files and credits.
 */
export async function imageQa(o: {
  cfg: ChannelConfig; dir: string; videoId: number; used: Set<string>;
  scenes: { id: string; imageQuery: string; narration: string }[];
  files: string[]; credits: ImageCredit[]; rounds?: number;
}): Promise<{ files: string[]; credits: ImageCredit[]; rejected: number }> {
  if (!providerSupportsVision()) return { files: o.files, credits: o.credits, rejected: 0 };
  let rejected = 0;

  const attempts = new Map<number, number>();
  const stillIdx = o.files.map((f, i) => (/\.(mp4|mov|webm)$/i.test(f) ? -1 : i)).filter((i) => i >= 0);
  for (let round = 0; round < (o.rounds ?? 2); round++) {
    const bad = new Set<number>();
    for (let start = 0; start < stillIdx.length; start += SHEET) {
      const idxBatch = stillIdx.slice(start, start + SHEET);
      const batch = idxBatch.map((i) => o.files[i]!);
      const img = path.join(o.dir, `qa-${round}-${start}.jpg`);
      await sheet(batch, img);
      const qa = await askJson({
        tier: "heavy",
        images: [img],
        schema: QaSchema,
        system: `You are a picture editor checking images before they go into a published video.
REJECT an image if ANY of these is true:
- it shows a company, agency or sports logo, insignia, patch, emblem, wordmark or branded livery (including logos painted on vehicles, rockets, buildings or uniforms);
- an identifiable person's face is visible, or it is a photo of people posing, working or at an event;
- it carries a watermark, stock-photo overlay, caption bar or large embedded text;
- it does not depict the subject of its caption;
- it is blurry, tiny, a collage, or a screenshot of a webpage.
Otherwise keep it. Be strict: a rejected image costs one retry, a bad image published costs the channel.`,
        prompt: `The attached contact sheet has ${batch.length} images in a grid, numbered left to right, top to bottom starting at 1.
Each image is meant to illustrate this narration:
${idxBatch.map((sceneIdx, i) => `${i + 1}. "${o.scenes[sceneIdx]?.imageQuery}" — ${o.scenes[sceneIdx]?.narration.slice(0, 160)}`).join("\n")}

List ONLY the images to reject.`,
      }).catch(async (e) => { await incident("image-qa", e, o.videoId); return { rejects: [] as z.infer<typeof QaSchema>["rejects"] }; });

      if (qa.rejects.filter((r) => /blank|missing|white/i.test(r.note)).length > batch.length / 2) {
        await incident("image-qa.sheet", new Error(`contact sheet looked blank for ${batch.length} images; skipping this batch rather than replacing good pictures`), o.videoId);
        await fs.rm(img, { force: true });
        continue;
      }
      for (const r of qa.rejects) {
        const idx = idxBatch[r.index - 1] ?? -1;
        if (idx >= 0) {
          bad.add(idx);
          log(`  image ${idx + 1} rejected (${r.reason}): ${r.note.slice(0, 90)}`);
        }
      }
      await fs.rm(img, { force: true });
    }
    if (!bad.size) break;
    if (bad.size > stillIdx.length * 0.6) {
      await incident("image-qa.distrusted", new Error(`${bad.size}/${stillIdx.length} images rejected in one pass — treating the review as unreliable`), o.videoId);
      break;
    }
    rejected += bad.size;

    let done = 0;
    for (const idx of bad) {
      const scene = o.scenes[idx]!;
      if (++done % 3 === 0) log(`  replacing image ${done}/${bad.size}`);
      const got = await replaceSceneImage(o.cfg, scene, o.files[idx]!, o.used, o.videoId).catch(() => null);
      if (got) o.credits[idx] = got;
    }
  }
  return { files: o.files, credits: o.credits, rejected };
}
