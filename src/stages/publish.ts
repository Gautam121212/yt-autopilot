import fs from "node:fs";
import type { ChannelConfig } from "../config";
import { yt } from "../lib/youtube";
import { ts } from "../lib/media";
import type { Dossier, Scene, SceneTiming, Script } from "../types";

const CREDIT = "Narration voice is AI-generated. Imagery is public-domain or freely licensed; see credits above.";

export function buildDescription(script: Script, scenes: Scene[], timings: SceneTiming[], dossier: Dossier, credits: { source: string; attribution?: string }[] = []): string {
  const chapters = scenes
    .map((s, i) => (s.chapter ? `${ts(timings[i]!.start)} ${s.chapter}` : null))
    .filter(Boolean);
  if (!chapters[0]?.startsWith("0:00")) chapters.unshift("0:00 Intro");
  const sources = dossier.sources.map((s) => `- ${s.title}: ${s.url}`);
  const footer = `\n\n${CREDIT}`;
  let desc = `${script.description}\n\nChapters\n${chapters.join("\n")}\n\nSources\n`;
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
