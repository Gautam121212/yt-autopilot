/**
 * Clipper M2 — orchestrator. Runs the full cascade from a YouTube URL to final deliverable(s):
 *
 *   1. yt-shorts LLM pick  (M1 pickCandidates)   → 3-5 candidate windows with narrative gates
 *   2. extract              (download + cut)      → one mp4 per candidate
 *   3. polish               (loudnorm + fade)     → one polished mp4 per candidate
 *   4. score                (7 gates, strict)     → score + pass/fail per clip
 *   5. recover              (auto-editor)         → re-run through auto-editor on failures
 *   6. re-score the recovered clips. Still failing → DROP (don't ship bad work).
 *   7. decide               (shorts | long)       → pick ONE format based on passing total
 *   8. assemble             (crop or concat)      → final deliverable(s)
 *   9. manifest             (JSON summary)        → what was shipped, what was dropped, why
 *
 * Usage (local):
 *   npm run clip:build -- "<youtube-url>"
 *   npm run clip:build -- "<url>" --format auto      # (default) model decides
 *   npm run clip:build -- "<url>" --format shorts    # force shorts path
 *   npm run clip:build -- "<url>" --format long      # force long path
 *   npm run clip:build -- "<url>" --out work/clipper # output root
 *
 * On GitHub Actions this is invoked by .github/workflows/clip.yml. Everything downloads, scores,
 * and renders on the runner; the user never heats their laptop.
 *
 * LEGAL: downloads a video the user did not create. User has accepted copyright responsibility.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMeta, fetchCaptions, pickCandidates, type ClipCandidate } from "../src/lib/yt-clipper.js";
import { extractAll } from "../src/lib/clipper/extract.js";
import { polish } from "../src/lib/clipper/polish.js";
import { measureAndScore, type ScoreResult } from "../src/lib/clipper/score.js";
import { recover } from "../src/lib/clipper/recover.js";
import { decide } from "../src/lib/clipper/decide.js";
import { makeShort, concatLong, writeManifest } from "../src/lib/clipper/assemble.js";

type Format = "auto" | "shorts" | "long";
function parseArgs(argv: string[]): { url: string; outRoot: string; format: Format; lang: string; maxHeight: number } {
  let url = "";
  let outRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "work", "clipper");
  let format: Format = "auto";
  let lang = "en";
  let maxHeight = 1080;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out" && args[i + 1]) outRoot = path.resolve(args[++i]!);
    else if (a === "--format" && args[i + 1]) format = args[++i]! as Format;
    else if (a === "--lang" && args[i + 1]) lang = args[++i]!;
    else if (a === "--max-height" && args[i + 1]) maxHeight = Number(args[++i]!);
    else if (!a.startsWith("--") && !url) url = a;
  }
  if (!url) { console.error("usage: npm run clip:build -- <url> [--format auto|shorts|long] [--max-height 1080|720|480] [--out dir] [--lang en]"); process.exit(2); }
  return { url, outRoot, format, lang, maxHeight };
}

async function main() {
  const { url, outRoot, format, lang, maxHeight } = parseArgs(process.argv);
  const workDir = path.join(outRoot, Date.now().toString());
  await mkdir(workDir, { recursive: true });
  console.log(`[clip:build] work dir: ${workDir}`);

  console.log("[clip:build] step 1/9: LLM picks candidates");
  const meta = await fetchMeta(url);
  const cues = await fetchCaptions(url, lang);
  const list = await pickCandidates(meta, cues);
  console.log(`  → ${list.candidates.length} candidates`);

  console.log(`[clip:build] step 2/9: extract (section-only downloads, ≤${maxHeight}p)`);
  const extracted = await extractAll(url, list.candidates, workDir, maxHeight);
  console.log(`  → ${extracted.length} raw clips`);

  console.log("[clip:build] step 3/9: polish (loudnorm + fade)");
  const polishedDir = path.join(workDir, "polished");
  await mkdir(polishedDir, { recursive: true });
  const polished: { candidate: ClipCandidate; path: string }[] = [];
  for (const e of extracted) {
    const p = await polish(e.rawPath, polishedDir);
    polished.push({ candidate: e.candidate, path: p.outputPath });
  }
  console.log(`  → ${polished.length} polished`);

  // Default band assumption for initial scoring is "shorts" — most LLM picks are 20-60s. If we
  // later pivot to long, decide() just works off whether CLIPS passed, not duration band per se.
  const probeBand = format === "long" ? "long" : "shorts";
  console.log(`[clip:build] step 4/9: score (strict gates, band=${probeBand})`);
  let scored: ScoreResult[] = [];
  for (const p of polished) {
    const s = await measureAndScore(p.path, probeBand);
    scored.push(s);
    console.log(`  clip ${path.basename(p.path).padEnd(50)} score=${s.score}  ${s.passed ? "PASS" : "FAIL"}${s.criticalFails.length ? " [critical: " + s.criticalFails.join(",") + "]" : ""}`);
  }

  const failing = scored.filter((s) => !s.passed);
  if (failing.length) {
    console.log(`[clip:build] step 5/9: recover ${failing.length} failing clips via auto-editor`);
    const recoveredDir = path.join(workDir, "recovered");
    await mkdir(recoveredDir, { recursive: true });
    for (const s of failing) {
      try {
        const r = await recover(s.path, recoveredDir);
        const re = await measureAndScore(r.outputPath, probeBand);
        console.log(`  recovered ${path.basename(r.outputPath).padEnd(50)} score=${re.score}  ${re.passed ? "PASS" : "FAIL"}`);
        if (re.passed) {
          // Replace the original failing entry with the recovered one.
          const idx = scored.findIndex((x) => x.path === s.path);
          if (idx >= 0) scored[idx] = re;
        }
      } catch (e) {
        console.warn(`  recover failed for ${s.path}: ${(e as Error).message}`);
      }
    }
  } else {
    console.log("[clip:build] step 5/9: no failing clips, skipping recover");
  }

  console.log("[clip:build] step 6/9: decide format");
  const d = format === "auto" ? decide(scored) : (() => {
    const forced = decide(scored);
    forced.format = format === "long" ? "long" : "shorts";
    return forced;
  })();
  console.log(`  → ${d.format.toUpperCase()}: ${d.rationale}`);
  if (d.format === "none") {
    console.error("\n✗ nothing shipped. Try a different source video.");
    await writeManifest(workDir, { meta, decision: d, scored });
    process.exit(1);
  }

  console.log(`[clip:build] step 7/9: assemble (${d.format})`);
  const finalDir = path.join(workDir, "final");
  await mkdir(finalDir, { recursive: true });
  const outputs: string[] = [];
  if (d.format === "shorts") {
    for (let i = 0; i < d.chosen.length; i++) {
      const s = d.chosen[i]!;
      const out = await makeShort(s.path, finalDir, String(i + 1).padStart(2, "0"));
      outputs.push(out);
      console.log(`  short ${i + 1} → ${path.basename(out)}`);
    }
  } else {
    const out = await concatLong(d.chosen.map((c) => c.path), finalDir);
    outputs.push(out);
    console.log(`  long → ${path.basename(out)}`);
  }

  console.log("[clip:build] step 8/9: manifest");
  const manifest = await writeManifest(workDir, {
    source: { url, title: meta.title, uploader: meta.uploader, durationSec: meta.durationSec },
    picks: list.candidates,
    scoredAll: scored,
    decision: d,
    outputs,
  });
  console.log(`  manifest → ${manifest}`);

  console.log("\n✓ clip:build done");
  console.log(`  format:  ${d.format}`);
  console.log(`  outputs: ${outputs.length}`);
  for (const o of outputs) console.log(`           ${o}`);
}

main().catch((e) => { console.error(`\n✗ clip:build failed: ${(e as Error).stack ?? e}`); process.exit(1); });
