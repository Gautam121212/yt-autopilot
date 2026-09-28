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
  // Smaller sheets = fewer image tokens per Groq call. The 4x4/4x2 at 480/270 px per tile produced
  // a 1920x2160 combined payload that repeatedly tripped Groq's free-tier per-minute token budget
  // (28 Sep 07:07 UTC #14: qwen/qwen3.8-27b hit the per-minute cap three times in a row even with
  // 65s waits, because a single call was already over the TPM window). 3x3/3x2 at 320 px halves
  // the pixels while still showing the reviewer the shape of the video.
  await contactSheet(o.videoPath, path.join(o.dir, "contact-long.jpg"), 3, 3, 320);
  if (o.shortPath) await contactSheet(o.shortPath, path.join(o.dir, "contact-short.jpg"), 3, 2, 240);
  const pack = [
    `# Title\n${o.script.title}\n\nAlt titles: ${o.script.altTitles.join(" | ")}`,
    `# Thumbnail text\n${o.script.thumbnailText}`,
    `# Description\n${o.description}`,
    `# Short title\n${o.script.short.title}`,
    `# Standards review already done\n${o.verification.summary}`,
    `# Narration by scene (with the stock footage actually used)\n${o.script.scenes.map((s, i) => `[${s.id}] image: "${o.credits[i]?.title ?? "?"}"\n${s.narration}`).join("\n\n")}`,
    `# Short narration\n${o.script.short.scenes.map((s) => s.narration).join(" ")}`,
  ].join("\n\n");
  await fs.writeFile(path.join(o.dir, "review-pack.md"), pack);

  const vision = providerSupportsVision();
  const wanted = [path.join(o.dir, "thumbnail.jpg"), path.join(o.dir, "contact-long.jpg"), ...(o.shortPath ? [path.join(o.dir, "contact-short.jpg")] : [])];
  // Only include images that exist — a resumed render may not have saved the thumbnail, and a missing
  // file must degrade the review, never crash it (which the caller wrongly reads as "vision down").
  const images: string[] = [];
  for (const f of wanted) { try { await fs.stat(f); images.push(f); } catch { /* skip missing */ } }

  // TWO calls, not one (#95). The single review sent three images PLUS the whole script, schema and
  // rubric to the vision provider and asked for a long answer under a 1000-token ceiling. On Groq's
  // free tier (~6k tokens/minute, reserved output included — #88, #92) that request could not fit,
  // so every final check fell through to Gemini and was deferred. Now the vision provider only looks
  // at pixels and answers briefly; the text-only judge reads the script and makes the decision.
  let visual: VisualCheck | null = null;
  if (vision && images.length) {
    const scenes = o.script.scenes.map((s, i) =>
      `[${s.id}] image: "${(o.credits[i]?.title ?? "?").slice(0, 60)}" — ${s.narration.replace(/\s+/g, " ").slice(0, 90)}`).join("\n");
    visual = await askJson({
      tier: "light",
      role: "vision",
      images,
      visionMaxTokens: Number(process.env.REVIEW_VISION_MAX_TOKENS ?? 1500),
      schema: VisualCheckSchema,
      system: VISUAL_SYSTEM,
      prompt: `Images: the thumbnail (text on it: "${o.script.thumbnailText}"), a 3x3 sheet of frames sampled across the long video` +
        `${o.shortPath ? ", and a 3x2 sheet from the Short" : ""}.\n\nScenes in order (id, stock image used, start of its line):\n${scenes}\n\n` +
        `Return JSON: { "visualsMatch", "thumbnail", "issues": [{ "severity", "area", "sceneId", "what", "fix" }] }. ` +
        `At most 6 issues; "what" and "fix" under 15 words each.`,
    });
  }

  const visualNote = visual
    ? `# Visual check (a separate pass that LOOKED at the thumbnail and frames — trust it for anything visual)\n` +
      `visualsMatch ${visual.visualsMatch}/10, thumbnail ${visual.thumbnail}/10\n` +
      (visual.issues.map((i) => `- [${i.severity}] ${i.area}${i.sceneId ? ` ${i.sceneId}` : ""}: ${i.what} -> ${i.fix}`).join("\n") || "- no visual issues")
    : `(No images were available: judge on text only and be stricter.)`;

  return askJson({
    tier: "heavy",
    role: "judge",
    schema: ReviewSchema,
    system: REVIEW_SYSTEM,
    prompt: `${pack}\n\n${visualNote}\n\nReturn your decision. Use the visual check's scores for visualsMatch and thumbnail; do not invent visual problems it did not report.`,
  }).then((r) => {
    if (visual) {
      // The pixels were judged by the model that saw them; the text judge may not overrule that.
      r.scores.visualsMatch = visual.visualsMatch;
      r.scores.thumbnail = visual.thumbnail;
      for (const vi of visual.issues) {
        if (!r.issues.some((i) => i.what === vi.what)) r.issues.push({ ...vi, sceneId: vi.sceneId ?? null });
      }
    }
    // A hold is a hold: a blocker can never be outvoted by a high average.
    if (r.issues.some((i) => i.severity === "blocker")) { r.decision = "hold"; r.overall = Math.min(r.overall, 5); }
    return r;
  });
}

const lower = (x: unknown) => (typeof x === "string" ? x.trim().toLowerCase() : x);
const VisualCheckSchema = z.object({
  visualsMatch: z.coerce.number().min(0).max(10),
  thumbnail: z.coerce.number().min(0).max(10),
  issues: z.array(z.object({
    severity: z.preprocess((x) => { const v = lower(x); return v === "blocker" || v === "major" ? v : "minor"; }, z.enum(["blocker", "major", "minor"])),
    area: z.preprocess((x) => (lower(x) === "thumbnail" ? "thumbnail" : "image"), z.enum(["image", "thumbnail"])),
    sceneId: z.string().nullable().optional(),
    what: z.string(),
    fix: z.string(),
  })).default([]),
});
type VisualCheck = z.infer<typeof VisualCheckSchema>;

const VISUAL_SYSTEM = `You are checking the PICTURES of a documentary-style YouTube video before it is published.
This is B-roll from stock libraries: a shot of the right subject, material, setting or kind of action is
correct and expected. Never flag a shot for not being the literal historical event.

Report as a BLOCKER any of these:
- a logo, insignia, wordmark or branded livery; an identifiable person as the subject; a watermark or caption bar;
- protest signs, placards, political or activist slogans, campaign material, or national/religious symbols
  used as a message — they are off-brand for this channel whatever the topic;
- an image UNRELATED to its line (a different subject entirely), or the wrong era (modern cars, phones or
  clothing in a period story);
- thumbnail text that is unreadable or cut off.
Report as MAJOR: the same shot visibly repeated in neighbouring frames; a blurry or stretched image.

Scores: visualsMatch 8+ when every shot is the right subject or setting for its line, 6-7 when a few are
merely generic, below 5 only when shots are unrelated or wrong-era. thumbnail: how well it would earn a
click from a stranger (10 = you would click).
Set "sceneId" when you can tell which scene a problem is in, else null.`;

const REVIEW_SYSTEM = `You are the channel owner's final quality gate. You decide whether this video goes out under their name.
You are not grading effort. Score how it would land on a stranger scrolling YouTube.

HOLD (blocker) if ANY of these is true:
- a factual claim, number or title is unsupported or overstated;
- any frame shows a logo, insignia, wordmark or branded livery; an identifiable person; a watermark or embedded caption bar;
- any image is UNRELATED to its narration — a different subject entirely, the wrong era (modern cars, phones
  or clothing in a period story), or something that contradicts the line. This is documentary B-roll from
  stock libraries: a shot of the right subject, material, setting or kind of action is CORRECT and expected.
  Never hold because a shot is not the literal historical event — stock cannot show that, and every
  documentary on television uses B-roll the same way;
- the thumbnail text is unreadable, cut off, or promises something the video doesn't deliver;
- the thumbnail text is a DESCRIPTION rather than a reaction or a punchline ("The History of X" is a hold;
  "HE DRANK IT ON PURPOSE" is right for this channel);
- the first 20 seconds contain no concrete, specific hook (a number, a name, a strange fact);
- the script is humourless: this channel is deadpan and funny-because-true, so a solemn lecture is a hold
  even when every fact is correct;
- more than a sixth of the scenes are full-screen text slides, which makes it look like a presentation;
- it reads as a reworded encyclopedia article with no original explanation or comparison;
- it gives medical, psychological, legal or financial advice, or invites the viewer to self-diagnose.

The publish bar is set by the channel owner and may be below 10. That changes NOTHING about the blockers above:
a blocker is still a hold no matter how high the other scores are. Score honestly rather than generously —
a video that scrapes the bar should feel like it scraped it.

SCORING (be harsh; the bar should feel earned):
- 10 = you would send this to a friend. 8 = you would watch it to the end. 6 = you would click away at the midpoint.
- 5 or below for anything that is competent but forgettable.
Score visualsMatch as a documentary editor would: 8+ when every shot is the right subject or setting for its
line, 6-7 when a few are merely generic, below 5 only when shots are unrelated or wrong-era. Not on prettiness,
and not on whether a shot is the literal event.

You may propose a better title or description intro, only if it is BOTH more accurate and more compelling.

For every issue, set "area" to what must actually change: "image" (wrong/unusable picture), "script" (weak hook,
flat section, wrong claim), "title", "thumbnail", "audio", or "other". Set "sceneId" when the problem is in a
specific scene. The pipeline repairs issues automatically using these fields, so be precise.`;
