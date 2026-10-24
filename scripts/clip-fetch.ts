/**
 * Clipper M4 — fetch (Mac self-hosted). Takes a plan.json, downloads ONLY the chosen windows
 * via yt-dlp --download-sections, writes mp4s to the output dir, writes a sections.json manifest
 * next to them. Mac does nothing else — no LLM, no polish, no scoring. Lightweight: ~2-5 min
 * depending on how many picks and their total duration.
 *
 * This is what gets uploaded as the "sections" artifact that clip-process (Ubuntu) picks up.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadSection } from "../src/lib/clipper/extract.js";

function parseArgs(argv: string[]): { plan: string; out: string; maxHeight: number } {
  let plan = "work/clipper/plan.json", out = "work/clipper/sections", maxHeight = 1080;
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--plan" && a[i + 1]) plan = a[++i]!;
    else if (a[i] === "--out" && a[i + 1]) out = a[++i]!;
    else if (a[i] === "--max-height" && a[i + 1]) maxHeight = Number(a[++i]!);
  }
  return { plan, out, maxHeight };
}

async function main() {
  const { plan: planPath, out, maxHeight } = parseArgs(process.argv);
  const p = JSON.parse(await readFile(planPath, "utf8")) as { url: string; meta: unknown; picks: Array<{ rank: number; startSec: number; endSec: number }> };
  console.log(`[clip:fetch] ${p.picks.length} sections, ≤${maxHeight}p`);
  await mkdir(out, { recursive: true });
  const sections: Array<{ rank: number; path: string }> = [];
  for (const pick of p.picks) {
    try {
      // downloadSection expects a ClipCandidate — we pass the fields it uses.
      const file = await downloadSection(p.url, pick as never, out, maxHeight);
      sections.push({ rank: pick.rank, path: path.basename(file) });
      console.log(`  ✓ rank ${pick.rank} [${Math.floor(pick.startSec)}-${Math.floor(pick.endSec)}s] → ${path.basename(file)}`);
    } catch (e) {
      console.warn(`  ✗ rank ${pick.rank}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  await writeFile(path.join(out, "sections.json"), JSON.stringify({ url: p.url, meta: p.meta, sections, picks: p.picks }, null, 2));
  console.log(`✓ wrote ${sections.length} sections + sections.json → ${out}`);
}

main().catch((e) => { console.error(`\n✗ clip:fetch failed: ${(e as Error).stack ?? e}`); process.exit(1); });
