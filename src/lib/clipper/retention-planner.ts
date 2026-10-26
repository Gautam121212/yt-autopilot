/**
 * Clipper M5 — retention-driven planner. Replaces (and falls back to) the LLM pick.
 *
 * Flow:
 *   1. Pull heatmap + chapters + top comments via signals.ts
 *   2. Build engagement curve + extract peaks (short-length band 20-90s)
 *   3. Also extract LONG peaks (>=4min) for the long-form path
 *   4. Format decision ("shorts" | "long") per user rule:
 *        - longest single peak >= 4 min → LONG form from that peak
 *        - else → SHORTS from top 3-5 short peaks (non-overlapping with long)
 *   5. Fall back to LLM pick (yt-clipper.pickCandidates) if NO signals arrived at all
 *      (video has no heatmap, no comments with timestamps, no chapters — rare for anything popular)
 *
 * Output is a plan.json compatible with M4's clip-fetch script, but augmented with the retention
 * strength per pick + a `format` hint used by decide.ts to short-circuit the old sum-based rule.
 */
import { retentionPeaks, type Peak } from "./signals.js";
import { fetchMeta, fetchCaptions, pickCandidates, type ClipCandidate, type VideoMeta } from "../yt-clipper.js";

export type RetentionPlan = {
  url: string;
  meta: VideoMeta;
  picks: ClipCandidate[];
  format: "shorts" | "long";
  source: "retention" | "llm-fallback";
  curveSignals: string[];        // which signals contributed: heatmap / comments / chapters
};

const SHORT_MIN = 20, SHORT_MAX = 90;
const LONG_MIN_SEC = 4 * 60;     // "retention of 5-6 min → long" rule, we trigger from 4+
const LONG_MAX_SEC = 15 * 60;    // cap at 15 min for a single clip
const MAX_SHORTS = 5;

/** Non-overlap check: does [aS, aE] overlap with [bS, bE] by more than 10s? */
function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  const overlap = Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  return overlap > 10;
}

/** Convert a Peak into a ClipCandidate shape (keeping M4's downstream expectations). The hook/
 *  framing/rationale fields are placeholders describing retention evidence; downstream polish /
 *  score / crop-safety steps operate on the actual clip, not on these strings. */
function peakToCandidate(p: Peak, rank: number): ClipCandidate {
  return {
    rank,
    startSec: p.startSec,
    endSec: p.endSec,
    originalFirstLine: "",
    newFirstLine: `(retention peak, strength ${p.strength.toFixed(2)}, sources: ${p.sources.join("+")})`,
    onScreenText: "",
    loopPoint: "retention-driven",
    framingNote: "crop-safety checked downstream",
    rationale: `Audience-retention signal: strength ${p.strength.toFixed(2)} from ${p.sources.join("+")} across ${p.endSec - p.startSec}s`,
  };
}

export async function plan(url: string): Promise<RetentionPlan> {
  const meta = await fetchMeta(url);
  console.log(`[retention-planner] ${meta.title} by ${meta.uploader} — ${meta.durationSec}s`);

  // Pull short-band peaks AND long-band peaks from the same curve (one yt-dlp -J call via
  // retentionPeaks + a re-call with different bands — share the fetched data via curve object).
  const shortPeaks = await retentionPeaks(url, SHORT_MIN, SHORT_MAX);
  const longPeaks = await retentionPeaks(url, LONG_MIN_SEC, LONG_MAX_SEC);
  console.log(`[retention-planner] curve from ${shortPeaks.curve.sources.join("+") || "(none)"} — ${shortPeaks.peaks.length} short peaks, ${longPeaks.peaks.length} long peaks`);

  // No signals at all → fall back to LLM pick on the transcript.
  if (!shortPeaks.curve.sources.length) {
    console.log(`[retention-planner] no retention signals; falling back to LLM pick on transcript`);
    const cues = await fetchCaptions(url);
    const list = await pickCandidates(meta, cues);
    return {
      url, meta,
      picks: list.candidates,
      format: "shorts",         // LLM mode defaults to shorts; decide.ts can still flip
      source: "llm-fallback",
      curveSignals: [],
    };
  }

  // Long-form path: top long peak ≥ 4 min wins format decision.
  const bestLong = longPeaks.peaks[0];
  if (bestLong && (bestLong.endSec - bestLong.startSec) >= LONG_MIN_SEC) {
    console.log(`[retention-planner] long peak [${bestLong.startSec}-${bestLong.endSec}s] strength ${bestLong.strength.toFixed(2)} — format=long`);
    return {
      url, meta,
      picks: [peakToCandidate(bestLong, 1)],
      format: "long",
      source: "retention",
      curveSignals: shortPeaks.curve.sources,
    };
  }

  // Shorts path: pick top MAX_SHORTS non-overlapping short peaks.
  const chosen: Peak[] = [];
  for (const p of shortPeaks.peaks) {
    if (chosen.length >= MAX_SHORTS) break;
    const dur = p.endSec - p.startSec;
    if (dur < SHORT_MIN || dur > SHORT_MAX) continue;
    if (p.endSec > meta.durationSec) continue;
    if (chosen.some((c) => overlaps(p.startSec, p.endSec, c.startSec, c.endSec))) continue;
    chosen.push(p);
  }
  console.log(`[retention-planner] chose ${chosen.length} non-overlapping short peaks — format=shorts`);
  if (!chosen.length) {
    // Signals present but no peaks fit the short band — fall back to LLM.
    const cues = await fetchCaptions(url);
    const list = await pickCandidates(meta, cues);
    return { url, meta, picks: list.candidates, format: "shorts", source: "llm-fallback", curveSignals: shortPeaks.curve.sources };
  }
  return {
    url, meta,
    picks: chosen.map((p, i) => peakToCandidate(p, i + 1)),
    format: "shorts",
    source: "retention",
    curveSignals: shortPeaks.curve.sources,
  };
}
