/**
 * Clipper M3 — discovery entrypoint. Reads data/clipper/config.json, calls the YouTube Data API,
 * ranks candidates by the composite viral score, writes the top-N to data/clipper/queue.json for
 * downstream jobs (download → polish → assemble) to pick up.
 *
 * Each surfaced video is also recorded in state.ts with status "discovered" so a future rerun
 * doesn't resurface it. If a video later lands in a terminal status (published/rejected/dropped)
 * it's permanently blacklisted and will never surface again.
 *
 * Usage:
 *   npm run clip:discover                       # uses data/clipper/config.json
 *   npm run clip:discover -- --top-n 5          # override how many to queue
 *   npm run clip:discover -- --dry              # print only, don't write queue or update state
 *
 * No bot-check — all requests go to googleapis.com, served to any valid key.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, type DiscoverConfig, type DiscoveredVideo } from "../src/lib/clipper/discover.js";
import { upsert } from "../src/lib/clipper/state.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "data", "clipper", "config.json");
const QUEUE = path.join(ROOT, "data", "clipper", "queue.json");

type FileConfig = {
  regionCodes: string[];
  categoryIds?: string[];
  channels?: Array<{ id: string; name?: string; note?: string }>;
  perRegionTrending?: number;
  perCategory?: number;
  perChannel?: number;
  minViews?: number;
  maxAgeDays?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  topN?: number;
};

function parseArgs(argv: string[]): { topN?: number; dry: boolean } {
  const a = argv.slice(2);
  let topN: number | undefined, dry = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--top-n" && a[i + 1]) topN = Number(a[++i]);
    else if (a[i] === "--dry") dry = true;
  }
  return { topN, dry };
}

async function main() {
  const { topN: topNOverride, dry } = parseArgs(process.argv);
  const key = process.env.YT_API_KEY;
  if (!key) { console.error("YT_API_KEY not set. Add it to .env or export it."); process.exit(2); }

  const raw = await readFile(CONFIG, "utf8");
  const file = JSON.parse(raw) as FileConfig;
  const cfg: DiscoverConfig = {
    apiKey: key,
    regionCodes: file.regionCodes,
    categoryIds: file.categoryIds,
    channelIds: file.channels?.map((c) => c.id),
    perRegionTrending: file.perRegionTrending,
    perCategory: file.perCategory,
    perChannel: file.perChannel,
    minViews: file.minViews,
    maxAgeDays: file.maxAgeDays,
    minDurationSec: file.minDurationSec,
    maxDurationSec: file.maxDurationSec,
  };
  const topN = topNOverride ?? file.topN ?? 20;

  console.log(`[clip:discover] regions=${cfg.regionCodes.join(",")} cats=${(cfg.categoryIds ?? []).length} channels=${(cfg.channelIds ?? []).length} top=${topN}${dry ? " [dry]" : ""}`);

  const picks = await discover(cfg, topN);

  console.log(`\n[clip:discover] top ${picks.length} picks:`);
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i]!;
    const mins = Math.round(p.durationSec / 60);
    const vpdK = Math.round((p.signals?.views_per_day ?? 0) / 1000);
    console.log(`  ${String(i + 1).padStart(2)}  ${p.id}  score=${Math.round((p.score ?? 0) * 10) / 10}  ${vpdK}k v/day  ${mins}min  "${p.title.slice(0, 70)}"`);
  }

  if (dry) { console.log("\n(dry run — queue and state not touched)"); return; }

  // Mark all as "discovered" so they don't resurface, and write the queue the download job reads.
  for (const p of picks) {
    await upsert(p.id, { title: p.title, channelTitle: p.channelTitle, status: "discovered" });
  }
  await mkdir(path.dirname(QUEUE), { recursive: true });
  await writeFile(QUEUE, JSON.stringify({ generatedAt: new Date().toISOString(), picks }, null, 2));
  console.log(`\n✓ wrote ${QUEUE} with ${picks.length} picks`);
  console.log(`  next step: npm run clip:build-queued  (download + polish + score + assemble)`);
}

main().catch((e) => { console.error(`\n✗ clip:discover failed: ${(e as Error).stack ?? e}`); process.exit(1); });
