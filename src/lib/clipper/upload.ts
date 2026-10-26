/**
 * Clipper M5 — direct YouTube upload. Reuses yt-autopilot's existing OAuth creds (YT_CLIENT_ID /
 * YT_CLIENT_SECRET / YT_REFRESH_TOKEN) and the googleapis wrapper in src/lib/youtube.ts.
 *
 * Private-by-default: new uploads land as `privacyStatus: "private"` so you can still look at them
 * in Studio before making them public. Call with `privacyStatus: "unlisted"` or `"public"` to
 * override. Shorts should typically go `public` with no title emoji because YouTube's Shorts
 * shelf picks on category + duration + aspect ratio, not keyword triggers.
 */
import fs from "node:fs";
import path from "node:path";
import { yt } from "../youtube.js";

export type UploadOpts = {
  filePath: string;
  title: string;
  description: string;
  tags?: string[];
  categoryId?: string;         // default 24 (Entertainment); 22 for People & Blogs
  privacyStatus?: "private" | "unlisted" | "public";
  madeForKids?: boolean;       // default false
  defaultLanguage?: string;    // default "en"
};

export async function uploadClip(opts: UploadOpts): Promise<{ videoId: string; studioUrl: string }> {
  const client = yt();
  const size = fs.statSync(opts.filePath).size;
  console.log(`[upload] ${path.basename(opts.filePath)} (${(size / 1024 / 1024).toFixed(1)} MB) → "${opts.title}"`);
  const res = await client.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: opts.title.slice(0, 100),
        description: opts.description.slice(0, 4800),
        tags: opts.tags?.slice(0, 20).map((t) => t.slice(0, 50)) ?? [],
        categoryId: opts.categoryId ?? "24",
        defaultLanguage: opts.defaultLanguage ?? "en",
      },
      status: {
        privacyStatus: opts.privacyStatus ?? "private",
        selfDeclaredMadeForKids: opts.madeForKids ?? false,
      },
    },
    media: { body: fs.createReadStream(opts.filePath) },
  });
  const videoId = res.data.id ?? "";
  const studioUrl = videoId ? `https://studio.youtube.com/video/${videoId}/edit` : "";
  console.log(`[upload] done → ${videoId}  ${studioUrl}`);
  return { videoId, studioUrl };
}
