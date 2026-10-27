/**
 * Clipper M8.4 — source provenance. Per spec section 9: "Build source provenance into the
 * workflow: record the original URL, creator, source identifier, permissions or licensing status
 * where available, and any relevant attribution requirements."
 *
 * We extract everything yt-dlp returns at fetch time (license, upload_date, uploader_id,
 * uploader_url, categories, age_limit) and write a provenance block into manifest.json.
 *
 * Legal honesty: YouTube's public API does NOT grant redistribution rights. yt-dlp's `license`
 * field reports "Creative Commons Attribution" when the uploader marked it; otherwise it's blank
 * meaning "Standard YouTube License" — NOT a redistribution grant. We encode this truthfully:
 *   - license: "cc-by" | "standard-youtube" | "unknown"
 *   - redistributionRights: "cc-permitted" | "unverified" | "unknown"
 *   - attributionRequired: true (always, for third-party clips)
 *
 * This does not grant rights we don't have; it records what we KNOW so a human review can
 * approve or reject each clip before upload.
 */
import { spawn } from "node:child_process";

export type Provenance = {
  sourceUrl: string;
  sourceId: string;
  uploader: string;
  uploaderId: string;
  uploaderUrl: string;
  title: string;
  description: string;         // truncated to 400 chars for the manifest
  viewCount: number;
  likeCount: number;
  commentCount: number;
  durationSec: number;
  publishedAt: string;         // ISO
  downloadedAt: string;        // ISO — when WE fetched it
  categoryId?: string;
  categories: string[];
  tags: string[];              // truncated to 20 for the manifest
  thumbnail?: string;
  license: "cc-by" | "standard-youtube" | "unknown";
  redistributionRights: "cc-permitted" | "unverified" | "unknown";
  attributionRequired: true;   // always true for third-party clips
  ageLimit: number;            // 0, 18, etc.
  availability?: string;       // "public" | "unlisted" | "private" | undefined
  sourceResolution: { width: number; height: number };
  reviewFlags: string[];       // human-review flags: "age-restricted", "resolution-below-720p", "no-license-info"
};

/** yt-dlp -J fields we parse. */
type DlpJson = {
  id: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  uploader_url?: string;
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  duration?: number;
  upload_date?: string;        // YYYYMMDD
  categories?: string[];
  tags?: string[];
  thumbnail?: string;
  license?: string;
  age_limit?: number;
  availability?: string;
  width?: number;
  height?: number;
  webpage_url?: string;
};

async function runCapture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c.toString()));
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.on("error", reject);
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function parseUploadDate(s?: string): string {
  if (!s || s.length !== 8) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`;
}

function classifyLicense(dlpLicense?: string): { license: Provenance["license"]; redistribution: Provenance["redistributionRights"] } {
  if (!dlpLicense) return { license: "unknown", redistribution: "unknown" };
  const l = dlpLicense.toLowerCase();
  if (l.includes("creative commons") || l.includes("cc")) return { license: "cc-by", redistribution: "cc-permitted" };
  if (l.includes("standard") || l.includes("youtube license")) return { license: "standard-youtube", redistribution: "unverified" };
  return { license: "unknown", redistribution: "unknown" };
}

/** Fetch full provenance for a URL via yt-dlp -J (no download). Honest about what's known. */
export async function fetchProvenance(url: string): Promise<Provenance | null> {
  try {
    const { stdout, code } = await runCapture("yt-dlp", ["-J", "--no-warnings", "--skip-download", url]);
    if (code !== 0) return null;
    const d = JSON.parse(stdout) as DlpJson;
    const { license, redistribution } = classifyLicense(d.license);
    const flags: string[] = [];
    if ((d.age_limit ?? 0) >= 18) flags.push("age-restricted");
    if ((d.height ?? 0) < 720) flags.push("resolution-below-720p");
    if (!d.license) flags.push("no-license-info");
    if (d.availability && d.availability !== "public") flags.push(`availability:${d.availability}`);
    return {
      sourceUrl: d.webpage_url ?? url,
      sourceId: d.id,
      uploader: d.uploader ?? d.channel ?? "",
      uploaderId: d.uploader_id ?? d.channel_id ?? "",
      uploaderUrl: d.uploader_url ?? d.channel_url ?? "",
      title: d.title ?? "",
      description: (d.description ?? "").slice(0, 400),
      viewCount: d.view_count ?? 0,
      likeCount: d.like_count ?? 0,
      commentCount: d.comment_count ?? 0,
      durationSec: d.duration ?? 0,
      publishedAt: parseUploadDate(d.upload_date),
      downloadedAt: new Date().toISOString(),
      categories: d.categories ?? [],
      tags: (d.tags ?? []).slice(0, 20),
      thumbnail: d.thumbnail,
      license, redistributionRights: redistribution, attributionRequired: true,
      ageLimit: d.age_limit ?? 0,
      availability: d.availability,
      sourceResolution: { width: d.width ?? 0, height: d.height ?? 0 },
      reviewFlags: flags,
    };
  } catch (e) {
    console.warn(`[provenance] fetch failed for ${url}: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}

/** Produce the attribution line we burn into the clip and put into descriptions. Honest short
 *  form: credits the creator, cites the source URL, states nature of use. */
export function attributionText(p: Provenance): string {
  return `Clip from "${p.title}" by ${p.uploader} — ${p.sourceUrl}. ` +
    (p.license === "cc-by" ? "Original released under Creative Commons Attribution." :
     "Original rights with the creator; used for commentary / discovery purposes.");
}
