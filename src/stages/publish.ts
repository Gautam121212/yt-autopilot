import fs from "node:fs";
import type { ChannelConfig } from "../config";
import { yt } from "../lib/youtube";
import { ts } from "../lib/media";
import type { Dossier, Scene, SceneTiming, Script } from "../types";

const CREDIT = "Narration voice is AI-generated. Imagery is public-domain or freely licensed; see credits above.";

/**
 * YouTube chapters, built from the beat sheet — which every script has by construction — rather than
 * from an optional per-scene field the writer rarely set (most videos got a lone "0:00 Intro", which
 * YouTube ignores). Chapters measurably lift average view duration on videos over five minutes.
 *
 * YouTube's rules, all enforced here: first chapter at 0:00, at least three, each at least 10 s long.
 * If they cannot all be met, returns [] and the description has no chapter section at all — one
 * short chapter disables every chapter on the video.
 *
 * Titles: the writer's own chapter title if it set one, else the scene's on-screen caption, else the
 * opening words of the scene. Never "Part 2" or "Step 3": the moment one topic ends and another is
 * announced is exactly when viewers leave, so titles should pull forward, not signpost.
 */
export function buildChapters(scenes: Scene[], timings: SceneTiming[]): string[] {
  const BREAK_AT = new Set(["cold_open", "escalation", "turn", "mechanism", "payoff"]);
  const MIN_GAP = 10;
  const title = (sc: Scene): string => {
    const raw = (sc.chapter || sc.cardHeadline || sc.narration.split(/[.!?]/)[0] || "").trim();
    const words = raw.replace(/\s+/g, " ").split(" ").slice(0, 7).join(" ");
    return words.length > 60 ? `${words.slice(0, 57)}…` : words;
  };
  const points: { at: number; title: string }[] = [];
  let lastRole = "";
  for (const [i, sc] of scenes.entries()) {
    const role = (sc as { role?: string }).role ?? "";
    const t = timings[i]?.start;
    // A chapter starts where the ROLE changes (so consecutive escalations, or a scene split in two,
    // stay one chapter), and never within 10 s of the previous one.
    if (t === undefined || !BREAK_AT.has(role) || role === lastRole) { lastRole = role || lastRole; continue; }
    lastRole = role;
    const at = points.length ? t : 0;
    if (points.length && at - points.at(-1)!.at < MIN_GAP) continue;
    const name = title(sc);
    if (!name || points.some((p) => p.title === name)) continue;
    points.push({ at, title: name });
  }
  // the last chapter must also run at least 10 s before the video ends
  const end = timings.at(-1)?.end ?? 0;
  while (points.length > 1 && end - points.at(-1)!.at < MIN_GAP) points.pop();
  if (points.length < 3 || points[0]!.at !== 0) return [];
  return points.map((p) => `${ts(p.at)} ${p.title}`);
}

export function buildDescription(script: Script, scenes: Scene[], timings: SceneTiming[], dossier: Dossier, credits: { source: string; attribution?: string }[] = []): string {
  const chapters = buildChapters(scenes, timings);
  const sources = dossier.sources.map((s) => `- ${s.title}: ${s.url}`);
  const footer = `\n\n${CREDIT}`;
  // No section at all rather than an invalid one: YouTube ignores chapters unless every rule holds,
  // and a lone "0:00 Intro" line just looks unfinished.
  let desc = `${script.description}\n\n${chapters.length ? `Chapters\n${chapters.join("\n")}\n\n` : ""}Sources\n`;
  for (const s of sources) if ((desc + s + footer).length < 4400) desc += s + "\n";

  // CC-BY / CC-BY-SA images must be credited; NASA imagery must not imply endorsement.
  const attributions = [...new Set(credits.map((c) => c.attribution).filter(Boolean) as string[])];
  if (credits.some((c) => c.source === "nasa")) {
    desc += `\nImagery: NASA (images.nasa.gov). NASA does not endorse this channel.\n`;
  }
  if (attributions.length) {
    desc += `\nImage credits\n`;
    for (const a of attributions) if ((desc + a + footer).length < 4800) desc += `- ${a}\n`;
  }
  return (desc + footer).replace(/[<>]/g, ""); // YouTube rejects angle brackets
}

function fitTags(tags: string[]) {
  const out: string[] = [];
  let len = 0;
  for (const t of tags) { if (len + t.length + 1 > 450) break; out.push(t); len += t.length + 1; }
  return out;
}

export function buildShortDescription(longYoutubeId: string | null, dossier: Dossier): string {
  return `${longYoutubeId ? `Full video: https://youtu.be/${longYoutubeId}\n\n` : ""}Sources: ${dossier.sources.map((s) => s.url).join(" ")}\n\n${CREDIT}\n#Shorts #space`.replace(/[<>]/g, "");
}

export async function upload(cfg: ChannelConfig, o: { videoPath: string; thumbPath?: string; srtPath: string; title: string; description: string; tags: string[] }): Promise<string> {
  const api = yt();
  const res = await api.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: o.title.slice(0, 100),
        description: o.description,
        tags: fitTags(o.tags),
        categoryId: cfg.categoryId,
        defaultLanguage: cfg.language,
        defaultAudioLanguage: cfg.language,
      },
      // Always private first. Scheduling (publishAt) happens only after approval.
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true } as Record<string, unknown>,
    },
    media: { body: fs.createReadStream(o.videoPath) },
  });
  const id = res.data.id;
  if (!id) throw new Error("upload returned no video id");

  // Custom thumbnails require a phone-verified channel; failure here should not lose the upload.
  if (o.thumbPath) {
    await api.thumbnails.set({ videoId: id, media: { body: fs.createReadStream(o.thumbPath) } })
      .catch((e) => console.warn("thumbnail upload failed:", (e as Error).message));
  }
  await api.captions.insert({
    part: ["snippet"],
    requestBody: { snippet: { videoId: id, language: cfg.language, name: "", isDraft: false } },
    media: { body: fs.createReadStream(o.srtPath) },
  }).catch((e) => console.warn("caption upload failed:", (e as Error).message));
  return id;
}

export async function schedulePublic(videoId: string, publishAt: Date, title?: string) {
  const api = yt();
  await api.videos.update({
    part: ["status"],
    requestBody: { id: videoId, status: { privacyStatus: "private", publishAt: publishAt.toISOString(), selfDeclaredMadeForKids: false, containsSyntheticMedia: true } as Record<string, unknown> },
  });
  if (title) {
    const cur = await api.videos.list({ part: ["snippet"], id: [videoId] });
    const snippet = cur.data.items?.[0]?.snippet;
    if (snippet) await api.videos.update({ part: ["snippet"], requestBody: { id: videoId, snippet: { ...snippet, title: title.slice(0, 100) } } });
  }
}
