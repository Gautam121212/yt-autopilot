/**
 * Final check on your behalf: Claude looks at the actual thumbnail and frames from the rendered videos
 * (contact sheets), reads the metadata + narration, and decides publish or hold. It can also improve
 * the title/description before upload.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { askJson, providerSupportsVision } from "../lib/llm";
import { durationSec, sh } from "../lib/media";
import type { Script, Verification } from "../types";
import type { ImageCredit } from "./visuals";

export const ReviewSchema = z.object({
  decision: z.enum(["publish", "hold"]),
  scores: z.object({ hook: z.number().min(0).max(10), clarity: z.number().min(0).max(10), visualsMatch: z.number().min(0).max(10), thumbnail: z.number().min(0).max(10), packaging: z.number().min(0).max(10) }),
  overall: z.number().min(0).max(10),
  issues: z.array(z.object({
    severity: z.enum(["blocker", "major", "minor"]),
    area: z.enum(["image", "script", "title", "thumbnail", "audio", "other"]).describe("what must change to fix it"),
    sceneId: z.string().nullable().describe("scene id when the problem is in one scene, else null"),
    what: z.string(),
    fix: z.string(),
  })),
  improvedTitle: z.string().max(100).nullable().describe("better accurate title, or null to keep"),
  improvedDescriptionIntro: z.string().max(1500).nullable().describe("better first paragraph of the description, or null to keep"),
  noteForOwner: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

async function contactSheet(video: string, out: string, cols: number, rows: number, w: number) {
  const n = cols * rows;
  const interval = Math.max(1, (await durationSec(video)) / (n + 1));
  await sh("ffmpeg", ["-y", "-i", video, "-vf", `fps=1/${interval.toFixed(2)},scale=${w}:-2,tile=${cols}x${rows}:padding=6:color=white`, "-frames:v", "1", "-q:v", "4", out]);
}

/** A review that cannot run is not a pass and not a crash: it is a hold for a human to look at. */
export function unreviewed(why: string): Review {
  return {
    decision: "hold",
    scores: { hook: 0, clarity: 0, visualsMatch: 0, thumbnail: 0, packaging: 0 },
    overall: 0,
    issues: [{ severity: "major", area: "other", sceneId: null, what: `The automatic review could not run: ${why}`, fix: "Watch it yourself and approve or reject." }],
    improvedTitle: null,
    improvedDescriptionIntro: null,
    noteForOwner: "The video is finished and uploaded privately, but the quality check failed to run. Please judge it yourself.",
  };
}

export async function finalReview(o: {
  dir: string; script: Script; verification: Verification; description: string;
  videoPath: string; shortPath?: string; credits: ImageCredit[];
}): Promise<Review> {
  await contactSheet(o.videoPath, path.join(o.dir, "contact-long.jpg"), 4, 4, 480);
  if (o.shortPath) await contactSheet(o.shortPath, path.join(o.dir, "contact-short.jpg"), 4, 2, 270);
  const pack = [
    `# Title\n${o.script.title}\n\nAlt titles: ${o.script.altTitles.join(" | ")}`,
    `# Thumbnail text\n${o.script.thumbnailText}`,
    `# Description\n${o.description}`,
    `# Short title\n${o.script.short.title}`,
    `# Standards review already done\n${o.verification.summary}`,
    `# Narration by scene (with the NASA image actually used)\n${o.script.scenes.map((s, i) => `[${s.id}] image: "${o.credits[i]?.title ?? "?"}"\n${s.narration}`).join("\n\n")}`,
    `# Short narration\n${o.script.short.scenes.map((s) => s.narration).join(" ")}`,
  ].join("\n\n");
  await fs.writeFile(path.join(o.dir, "review-pack.md"), pack);

  const vision = providerSupportsVision();
  // A hold is a hold: a blocker can never be outvoted by a high average.
  const images = [path.join(o.dir, "thumbnail.jpg"), path.join(o.dir, "contact-long.jpg"), ...(o.shortPath ? [path.join(o.dir, "contact-short.jpg")] : [])];
  return askJson({
    tier: "heavy",
    readDir: vision ? o.dir : undefined,
    images: vision ? images : undefined,
    schema: ReviewSchema,
    system: `You are the channel owner's final quality gate. You decide whether this video goes out under their name.
You are not grading effort. Score how it would land on a stranger scrolling YouTube.

HOLD (blocker) if ANY of these is true:
- a factual claim, number or title is unsupported or overstated;
- any frame shows a logo, insignia, wordmark or branded livery; an identifiable person; a watermark or embedded caption bar;
- any image does not depict what its narration says;
- the thumbnail text is unreadable, cut off, or promises something the video doesn't deliver;
- the first 20 seconds contain no concrete, specific hook (a number, a name, a strange fact);
- it reads as a reworded encyclopedia article with no original explanation or comparison;
- it gives medical, psychological, legal or financial advice, or invites the viewer to self-diagnose.

The publish bar is set by the channel owner and may be below 10. That changes NOTHING about the blockers above:
a blocker is still a hold no matter how high the other scores are. Score honestly rather than generously —
a video that scrapes the bar should feel like it scraped it.

SCORING (be harsh; the bar should feel earned):
- 10 = you would send this to a friend. 8 = you would watch it to the end. 6 = you would click away at the midpoint.
- 5 or below for anything that is competent but forgettable.
Score visualsMatch on whether each image earns its place, not on whether it is pretty.

You may propose a better title or description intro, only if it is BOTH more accurate and more compelling.

For every issue, set "area" to what must actually change: "image" (wrong/unusable picture), "script" (weak hook,
flat section, wrong claim), "title", "thumbnail", "audio", or "other". Set "sceneId" when the problem is in a
specific scene. The pipeline repairs issues automatically using these fields, so be precise.`,
    prompt: vision
      ? `You are shown: the thumbnail, a 4x4 sheet of frames sampled across the long video${o.shortPath ? ", and a 4x2 sheet from the Short" : ""}.\n\n${pack}\n\nJudge the images against the narration and return your decision.`
      : `${pack}\n\n(No images available with this provider: judge on text only and be stricter.)`,
  }).then((r) => {
    if (r.issues.some((i) => i.severity === "blocker")) { r.decision = "hold"; r.overall = Math.min(r.overall, 5); }
    return r;
  });
}
