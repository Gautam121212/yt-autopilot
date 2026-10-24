/**
 * Clipper M2 — decide. Picks ONE format for the source video based on how much good material
 * came out of the gates. The rule the user set:
 *
 *   - Count all clips that passed (gate ≥ 80, no critical fail).
 *   - If their combined duration is ≥ 7 minutes → go LONG (concatenate top passers into one piece
 *     of 7-15 min, discard the rest).
 *   - If less than 7 min of passing material → go SHORTS (ship each individual passing clip
 *     20-60s as its own Short).
 *   - Never both formats from the same source.
 *
 * This is intentionally harsh: better to ship 3 strong Shorts than a long video padded with weak
 * content, and better to ship one strong long video than 10 scattered Shorts when there's enough
 * substance to carry a longer piece.
 */
import type { ScoreResult } from "./score.js";

export type Decision = {
  format: "shorts" | "long" | "none";
  chosen: ScoreResult[];       // the clips we're actually shipping
  rejected: ScoreResult[];     // scored but didn't make the cut
  rationale: string;           // human-readable explanation for the log
  totalPassingSec: number;
};

const LONG_FLOOR_SEC = 7 * 60;   // ≥7 min of passing material → long form
const LONG_CAP_SEC = 15 * 60;    // long videos should fit in 7-15 min
const SHORTS_MAX = 5;            // ship at most 5 shorts

export function decide(scored: ScoreResult[]): Decision {
  const passing = scored.filter((s) => s.passed);
  const totalPassingSec = passing.reduce((n, s) => n + s.durationSec, 0);

  if (passing.length === 0) {
    return {
      format: "none",
      chosen: [],
      rejected: scored,
      totalPassingSec: 0,
      rationale: "No clips passed the gate thresholds. Drop this source and move on — do not ship bad work.",
    };
  }

  if (totalPassingSec >= LONG_FLOOR_SEC) {
    // Long form: take passing clips in rank order (score desc, then original rank) until we fill
    // 7-15 min. If one clip alone is already ≥15 min we just take it.
    const ranked = [...passing].sort((a, b) => b.score - a.score);
    const chosen: ScoreResult[] = [];
    let runningSec = 0;
    for (const c of ranked) {
      if (runningSec >= LONG_CAP_SEC) break;
      chosen.push(c);
      runningSec += c.durationSec;
      if (runningSec >= LONG_FLOOR_SEC && runningSec >= LONG_CAP_SEC * 0.9) break;
    }
    return {
      format: "long",
      chosen,
      rejected: scored.filter((s) => !chosen.includes(s)),
      totalPassingSec,
      rationale: `${passing.length} passing clips totaling ${(totalPassingSec / 60).toFixed(1)} min of good material — long form (combine ${chosen.length} top clips into one ${(runningSec / 60).toFixed(1)} min video).`,
    };
  }

  // Shorts: ship top SHORTS_MAX passers individually.
  const chosen = [...passing].sort((a, b) => b.score - a.score).slice(0, SHORTS_MAX);
  return {
    format: "shorts",
    chosen,
    rejected: scored.filter((s) => !chosen.includes(s)),
    totalPassingSec,
    rationale: `${passing.length} passing clips totaling ${(totalPassingSec / 60).toFixed(1)} min — under the ${LONG_FLOOR_SEC / 60} min long-form floor. Ship ${chosen.length} shorts individually.`,
  };
}
