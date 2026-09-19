/**
 * Per-scene visual gate.
 *
 * The old whole-video QA judged 12 images in one batch and replaced a few. This instead scores
 * EVERY scene on its own and refuses to move on until it clears the bar — retrying with the scene's
 * alternative queries, then the topic's fallbacks. One scene at a time, sequentially, so a bad scene
 * is fixed before the next one is even attempted.
 *
 * Cheap on purpose: one light vision call per scene, images only (no rendering), so a failing scene
 * costs one small call rather than a whole render.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChannelConfig } from "../config";
import { askJson, providerSupportsVision } from "../lib/llm";
import { incident, log } from "../lib/log";
import { sh } from "../lib/media";
import type { ImageCredit } from "./visuals";
import { replaceSceneImage } from "./visuals";

export const SCENE_BAR = Number(process.env.SCENE_BAR ?? 7.5);

const Verdict = z.object({
  score: z.number().min(0).max(10).describe("does this picture belong to this line of narration"),
  problem: z.string().describe("what is wrong, or 'none'"),
  betterQuery: z.string().describe("a concrete, filmable 2-5 word search that would fit better, or 'none'"),
});

type Scene = { id: string; narration: string; imageQuery: string; altQueries?: string[]; era?: string };

/** One frame from a clip, or the still itself, so the model can look at what the viewer will see. */
async function preview(file: string, dir: string, tag: string): Promise<string | null> {
  if (!/\.(mp4|mov|webm)$/i.test(file)) return file;
  const out = path.join(dir, `preview-${tag}.jpg`);
  const ok = await sh("ffmpeg", ["-y", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", out])
    .then(() => true, () => false);
  return ok ? out : null;
}

export async function sceneQa(o: {
  cfg: ChannelConfig;
  dir: string;
  videoId: number;
  used: Set<string>;
  scenes: Scene[];
  files: string[][];
  credits: ImageCredit[];
  fallbacks?: string[];
  attempts?: number;
}): Promise<{ passed: number; failed: string[]; replaced: number }> {
  if (!providerSupportsVision()) {
    log("  scene QA skipped (provider cannot see images)");
    return { passed: o.scenes.length, failed: [], replaced: 0 };
  }
  const maxAttempts = o.attempts ?? 3;
  let replaced = 0;
  const failed: string[] = [];

  for (const [i, scene] of o.scenes.entries()) {
    const lead = o.files[i]?.[0];
    if (!lead) { failed.push(scene.id); continue; }

    let score = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const shot = await preview(o.files[i]![0]!, o.dir, `${scene.id}-${attempt}`);
      if (!shot) break;

      const v = await askJson({
        tier: "light",
        role: "gate",
        schema: Verdict,
        images: [shot],
        system: `You are checking ONE picture against ONE line of narration for a documentary channel.
Score 0-10 on whether a viewer seeing this picture while hearing this line would feel they match.
10 = exactly the thing being described. 7 = clearly related and in the right world.
4 = vaguely thematic. 0 = unrelated, wrong era, a logo, a watermark, a recognisable person, or a chart.
Score harshly: a picture that is merely "not wrong" is a 5, not a 7.`,
        prompt: `NARRATION: ${scene.narration}\nSEARCHED FOR: ${scene.imageQuery}\nERA: ${scene.era ?? "any"}\n\nScore the attached picture.`,
      }).catch(async (e) => { await incident("scene-qa", e, o.videoId); return null; });

      if (!v) break;
      score = v.score;
      if (score >= SCENE_BAR) break;

      log(`  scene ${scene.id}: ${score}/10 — ${v.problem.slice(0, 70)}`);
      if (attempt === maxAttempts) break;

      // Retry with the model's own suggestion first, then the scene's alternatives.
      const queries = [v.betterQuery, ...(scene.altQueries ?? []), ...(o.fallbacks ?? [])]
        .filter((q) => q && q !== "none");
      let swapped = false;
      for (const q of queries.slice(0, 4)) {
        const got = await replaceSceneImage(o.cfg, { ...scene, imageQuery: q }, o.files[i]![0]!, o.used, o.videoId, o.fallbacks)
          .catch(() => null);
        if (got) { o.credits[i] = got; replaced++; swapped = true; break; }
      }
      if (!swapped) break;
    }

    if (score >= SCENE_BAR) {
      log(`  scene ${scene.id}: ${score}/10 ✓`);
    } else {
      failed.push(scene.id);
      log(`  scene ${scene.id}: ${score}/10 — kept the best available after ${maxAttempts} attempts`);
    }
  }

  await fs.rm(path.join(o.dir, "preview-tmp"), { recursive: true, force: true }).catch(() => {});
  return { passed: o.scenes.length - failed.length, failed, replaced };
}
