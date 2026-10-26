/**
 * Clipper M5 — direct YouTube Studio upload. Takes an approved clip + context and uploads it to
 * your channel via the existing OAuth creds in .env (YT_CLIENT_ID / YT_CLIENT_SECRET /
 * YT_REFRESH_TOKEN).
 *
 * Usage:
 *   npm run clip:upload -- --file path/to/short_01.mp4 --title "..." --desc "..." [--private]
 *   npm run clip:upload -- --manifest work/clipper/manifest.json --index 0 [--privacy private|unlisted|public]
 *
 * Writes a "published" outcome record so the learning loop knows this clip shipped. Default
 * privacy is "private" so the clip lands in Studio awaiting your final human eyes before going
 * public — matches the user's "accepted videos pushed to Studio" flow.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { uploadClip } from "../src/lib/clipper/upload.js";
import { recordPublished } from "../src/lib/clipper/outcomes.js";
import { upsert } from "../src/lib/clipper/state.js";

type Manifest = {
  source: { url: string; title: string; uploader: string; durationSec: number };
  decision: { format: "shorts" | "long" | "none"; chosen?: Array<{ path: string }> };
  outputs: string[];
};

function parseArgs(argv: string[]): { file?: string; title?: string; desc?: string; manifest?: string; index?: number; privacy: "private" | "unlisted" | "public" } {
  const a = argv.slice(2);
  const o: { file?: string; title?: string; desc?: string; manifest?: string; index?: number; privacy: "private" | "unlisted" | "public" } = { privacy: "private" };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--file" && a[i + 1]) o.file = a[++i];
    else if (a[i] === "--title" && a[i + 1]) o.title = a[++i];
    else if (a[i] === "--desc" && a[i + 1]) o.desc = a[++i];
    else if (a[i] === "--manifest" && a[i + 1]) o.manifest = a[++i];
    else if (a[i] === "--index" && a[i + 1]) o.index = Number(a[++i]);
    else if (a[i] === "--privacy" && a[i + 1]) o.privacy = a[++i] as "private" | "unlisted" | "public";
    else if (a[i] === "--public") o.privacy = "public";
    else if (a[i] === "--private") o.privacy = "private";
  }
  return o;
}

async function main() {
  const a = parseArgs(process.argv);
  let file = a.file, title = a.title, desc = a.desc, sourceVideoId = "";

  if (a.manifest) {
    const m = JSON.parse(await readFile(a.manifest, "utf8")) as Manifest;
    const idx = a.index ?? 0;
    file = file ?? m.outputs[idx];
    if (!file || !existsSync(file)) { console.error(`[upload] file not found at index ${idx} of manifest`); process.exit(2); }
    title = title ?? deriveTitle(m, idx);
    desc = desc ?? deriveDesc(m);
    sourceVideoId = m.source.url.match(/v=([A-Za-z0-9_-]{11})/)?.[1] ?? "";
  }

  if (!file || !existsSync(file)) { console.error("[upload] --file is required (or a valid --manifest)"); process.exit(2); }
  if (!title) { console.error("[upload] --title is required"); process.exit(2); }

  const res = await uploadClip({
    filePath: file,
    title,
    description: desc ?? "",
    privacyStatus: a.privacy,
    categoryId: "24",
  });

  if (sourceVideoId) {
    await recordPublished(sourceVideoId, res.videoId, { sourceTitle: title });
    await upsert(sourceVideoId, { title: title.slice(0, 100), channelTitle: "", status: "published", youtubeVideoId: res.videoId });
  }
  console.log(`\n✓ uploaded. Studio URL: ${res.studioUrl}`);
}

function deriveTitle(m: Manifest, idx: number): string {
  // yt-package-style: lead with the hook, cap at 100 chars, no vague trailers.
  const base = m.source.title.replace(/\s*\|\s*/g, " — ").slice(0, 80);
  return m.decision.format === "shorts" ? `${base} #Shorts` : base;
}

function deriveDesc(m: Manifest): string {
  // Credit the source channel. Short format gets a one-liner; long format gets more context.
  const credit = `Clip from "${m.source.title}" by ${m.source.uploader} — ${m.source.url}\n\nOriginal video all rights with the creator; this short is used for commentary / discovery purposes.`;
  return credit.slice(0, 4800);
}

main().catch((e) => { console.error(`✗ upload failed: ${(e as Error).stack ?? e}`); process.exit(1); });
