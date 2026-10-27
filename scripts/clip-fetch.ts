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
import { fetchProvenance } from "../src/lib/clipper/provenance.js";

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
  // M6.1: pass through the planner's `format` / `source` / `curveSignals` — the processor needs
  // the format hint; without it the decider silently falls back to "auto" and ignored a 4-min
  // long-form peak on the M5 trial run (shipped as a short).
  const p = JSON.parse(await readFile(planPath, "utf8")) as {
    url: string; meta: unknown;
    picks: Array<{ rank: number; startSec: number; endSec: number }>;
    format?: "shorts" | "long";
    source?: "retention" | "llm-fallback";
    curveSignals?: string[];
  };
  console.log(`[clip:fetch] ${p.picks.length} sections, ≤${maxHeight}p, format=${p.format ?? "(none)"}`);
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
  // M8.4: capture source provenance at fetch time (we have yt-dlp warm anyway). The processor
  // writes this into manifest.json. Non-fatal if provenance fetch fails — the clip still ships
  // with the metadata the planner already captured.
  const provenance = await fetchProvenance(p.url);
  if (provenance?.reviewFlags.length) {
    console.log(`  ⚠ provenance review flags: ${provenance.reviewFlags.join(", ")}`);
  }
  await writeFile(path.join(out, "sections.json"), JSON.stringify({
    url: p.url, meta: p.meta, sections, picks: p.picks,
    format: p.format, source: p.source, curveSignals: p.curveSignals,
    provenance,
  }, null, 2));
  console.log(`✓ wrote ${sections.length} sections + sections.json → ${out}`);
}

main().catch((e) => { console.error(`\n✗ clip:fetch failed: ${(e as Error).stack ?? e}`); process.exit(1); });
