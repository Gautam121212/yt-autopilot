/**
 * Clipper M3 — state. Tracks which videoIds have been reviewed so discovery never surfaces the
 * same video twice. Flat JSON on disk, committed to the repo, so state survives across CI runs
 * and sits visibly in git history (easy to audit, easy to prune by hand if needed).
 *
 * Status progression: discovered → clipped → pending → published | rejected.
 *   discovered  — surfaced by discover.ts, not yet acted on
 *   clipped     — ffmpeg + score pass completed, clip is in pending/
 *   pending     — awaiting human review (via GH issue or `npm run clip:review`)
 *   published   — pushed to YouTube Studio; permanently blacklisted
 *   rejected    — human said no; permanently blacklisted
 *   dropped     — gates failed, nothing to review; permanently blacklisted so we don't retry
 *
 * Only {published, rejected, dropped} count as "reviewed" for discover's filter — {discovered,
 * clipped, pending} are in-flight and discovery WILL re-skip them regardless (they're still in
 * the map), but a human can un-stick them manually by deleting the entry.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STATE_DIR = path.join(ROOT, "data", "clipper");
const STATE_FILE = path.join(STATE_DIR, "reviewed.json");

export type ReviewStatus = "discovered" | "clipped" | "pending" | "published" | "rejected" | "dropped";

export type ReviewRecord = {
  videoId: string;
  title: string;
  channelTitle: string;
  status: ReviewStatus;
  firstSeenAt: string;      // ISO
  updatedAt: string;        // ISO
  notes?: string;           // free text: why dropped, review comments, etc.
  clipPaths?: string[];     // paths to produced clips (relative to work/clipper)
  youtubeVideoId?: string;  // set when published; the uploaded video's new id
};

type StateFile = {
  version: 1;
  records: Record<string, ReviewRecord>;
};

const EMPTY: StateFile = { version: 1, records: {} };

async function load(): Promise<StateFile> {
  if (!existsSync(STATE_FILE)) return structuredClone(EMPTY);
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed.version !== 1) throw new Error(`unknown state version ${parsed.version}`);
    return parsed;
  } catch (e) {
    console.warn(`[state] failed to load ${STATE_FILE}: ${(e as Error).message}. Starting fresh.`);
    return structuredClone(EMPTY);
  }
}

async function save(s: StateFile): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  // Sort by firstSeenAt desc so the file reads like a timeline, newest at top.
  const sorted: StateFile = {
    version: 1,
    records: Object.fromEntries(
      Object.values(s.records).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)).map((r) => [r.videoId, r]),
    ),
  };
  await writeFile(STATE_FILE, JSON.stringify(sorted, null, 2) + "\n");
}

/** True if the video is in the terminal-status set (published / rejected / dropped). Discovery
 *  skips these so they never surface again. In-flight statuses are also present in the file but
 *  not counted here — in-flight items get re-skipped by the `recordExists` check in `upsert`. */
export async function isReviewed(videoId: string): Promise<boolean> {
  const s = await load();
  const r = s.records[videoId];
  if (!r) return false;
  // Any non-"discovered" status means this video is in-flight or terminal — skip it.
  return r.status !== "discovered";
}

/** True if the video has any record at all (even "discovered"). Useful for de-dup during a run. */
export async function recordExists(videoId: string): Promise<boolean> {
  const s = await load();
  return !!s.records[videoId];
}

export async function get(videoId: string): Promise<ReviewRecord | undefined> {
  const s = await load();
  return s.records[videoId];
}

/** Upsert — insert if new, update timestamp + any provided fields if existing. */
export async function upsert(videoId: string, patch: Partial<ReviewRecord> & Pick<ReviewRecord, "title" | "channelTitle"> & { status?: ReviewStatus }): Promise<ReviewRecord> {
  const s = await load();
  const now = new Date().toISOString();
  const existing = s.records[videoId];
  const next: ReviewRecord = {
    videoId,
    title: patch.title ?? existing?.title ?? "",
    channelTitle: patch.channelTitle ?? existing?.channelTitle ?? "",
    status: patch.status ?? existing?.status ?? "discovered",
    firstSeenAt: existing?.firstSeenAt ?? now,
    updatedAt: now,
    notes: patch.notes ?? existing?.notes,
    clipPaths: patch.clipPaths ?? existing?.clipPaths,
    youtubeVideoId: patch.youtubeVideoId ?? existing?.youtubeVideoId,
  };
  s.records[videoId] = next;
  await save(s);
  return next;
}

/** List all records matching a status filter. */
export async function list(statusFilter?: ReviewStatus | ReviewStatus[]): Promise<ReviewRecord[]> {
  const s = await load();
  const all = Object.values(s.records);
  if (!statusFilter) return all;
  const set = new Set(Array.isArray(statusFilter) ? statusFilter : [statusFilter]);
  return all.filter((r) => set.has(r.status));
}

/** Remove a record entirely. Use for manual reset (e.g. "clear this videoId, let me try it again"). */
export async function remove(videoId: string): Promise<boolean> {
  const s = await load();
  if (!s.records[videoId]) return false;
  delete s.records[videoId];
  await save(s);
  return true;
}
