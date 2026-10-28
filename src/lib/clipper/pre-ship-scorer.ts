/**
 * Clipper M12.3 — HARSH pre-ship viral scorer. Runs AFTER polish, score, crop-safety, assemble,
 * and QC — basically the last gate before a clip hits YouTube Studio. The user's rule: a clip
 * must score ≥8/10 on this scorer to ship, otherwise it feeds the learning loop instead.
 *
 * This is deliberately much stricter than the ranker's narrative classifier (which runs on raw
 * source candidates). By the time we're here, the clip is produced and polished — the question
 * is not "could this be good?" but "WOULD A HUMAN WATCH THIS TO THE END ON TIKTOK?".
 *
 * We feed the LLM:
 *   - clip transcript (via whisper SRT) — real evidence of what plays
 *   - duration, dimensions, format (shorts vs long)
 *   - the narrative-classifier verdict (if any) from source selection
 *   - the attribution title + channel
 *
 * The LLM is instructed to be MERCILESS: default to a low score, require evidence to raise it.
 * Scoring is 0-10 (not 0-100) so the 8-floor is unambiguous.
 */
import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { askJson } from "../llm.js";

export const PreShipVerdict = z.object({
  score: z.number().min(0).max(10),
  verdict: z.enum(["ship", "learn"]),
  dimensions: z.object({
    hookFirstSecond: z.number().min(0).max(10),
    payoffBeforeEnd: z.number().min(0).max(10),
    standaloneClarity: z.number().min(0).max(10),
    retentionBait: z.number().min(0).max(10),
    emotionalPeak: z.number().min(0).max(10),
  }),
  shipReasons: z.array(z.string()).max(5),
  learnReasons: z.array(z.string()).max(5),
  rationale: z.string().max(500),
});
export type PreShipVerdict = z.infer<typeof PreShipVerdict>;

const SYSTEM = `You are the FINAL gatekeeper deciding whether a produced short-form clip ships to YouTube Studio.
You MUST be harsh. The user's rule: only clips that would make a human stop scrolling and watch to the end are allowed through. Default to LEARN (don't ship), require evidence to flip to SHIP.

You score 0-10 (NOT 0-100). The ship threshold is 8. A clip scoring 7 is "almost but not quite" — mark LEARN with learnReasons so the ranker can improve.

Dimensions:
- hookFirstSecond: does the opening second IMMEDIATELY hook a cold scroller? (not minute 1 — SECOND 1)
- payoffBeforeEnd: is there a clear reward (laugh, insight, reveal, outcome) within the clip's duration?
- standaloneClarity: can a stranger with no context understand what's happening?
- retentionBait: does something keep pulling the viewer forward (building tension, question, loop)?
- emotionalPeak: at least one strong emotional moment — joy, shock, awe, catharsis, anger, suspense

Composite score (your judgment, 0-10):
- 10: top 1% viral. "I need to send this to a friend" energy.
- 8-9: SHIP. Would stop a scroll, hold attention, cold-viewer-friendly, memorable.
- 6-7: close but not quite. Something crucial missing — slow hook, vague payoff, unclear context.
- 4-5: forgettable. Technically fine but no reason a human stops scrolling.
- 0-3: should not have been produced. Filler, confusing, slow, no payoff.

HARSH rules:
- If the first 5 seconds of transcript have no hook word (question, surprise, action), hookFirstSecond ≤ 4.
- If the transcript is mostly setup with no visible payoff in the time window, payoffBeforeEnd ≤ 5.
- A "trailer breakdown" of something already released is standaloneClarity ≤ 4 and emotionalPeak ≤ 4.
- Monologues without visuals of what's being discussed: retentionBait ≤ 5.
- NEVER score ≥ 8 without concrete evidence in the transcript — specific hook phrase, specific payoff, specific emotional beat.

Output JSON only. shipReasons and learnReasons are concrete observations (specific words/phrases/moments from the transcript), not generic praise/complaint.`;

async function readSrtText(srtPath: string): Promise<string> {
  if (!existsSync(srtPath)) return "";
  try {
    const raw = await readFile(srtPath, "utf8");
    const blocks = raw.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
    const lines: string[] = [];
    for (const b of blocks) {
      const ls = b.split("\n");
      if (ls.length < 2) continue;
      const text = ls.slice(2).join(" ").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
    return lines.join("\n");
  } catch { return ""; }
}

export type ScoreInput = {
  clipTitle: string;
  sourceChannel: string;
  format: "shorts" | "long";
  durationSec: number;
  srtPath?: string;
  narrativeViral?: number;
  narrativeType?: string;
};

/** Harshly score a produced clip. Returns null when the LLM is unavailable — caller must treat
 *  null as "signal unavailable", NOT as a pass. Honest-signal rule. */
export async function scorePreShip(input: ScoreInput): Promise<PreShipVerdict | null> {
  const transcript = input.srtPath ? await readSrtText(input.srtPath) : "";
  // Guard: if we literally have no transcript on a clip we expect to be narrated, fall through
  // to the LLM with that fact explicit — it'll know to score hookFirstSecond low.
  const prompt = [
    `Clip title: ${input.clipTitle}`,
    `Source channel: ${input.sourceChannel}`,
    `Format: ${input.format} (${input.durationSec.toFixed(1)}s)`,
    input.narrativeType ? `Pre-production narrative type: ${input.narrativeType}` : "",
    input.narrativeViral !== undefined ? `Pre-production viral rating (source-level): ${input.narrativeViral}/100` : "",
    ``,
    transcript ? `TRANSCRIPT (what plays in the clip):\n${transcript.slice(0, 4000)}` : `NO TRANSCRIPT AVAILABLE — assume no spoken content.`,
    ``,
    `Score this against the rubric. BE HARSH. Default to LEARN unless the transcript shows strong hook + payoff + clarity.`,
    `Set verdict = "ship" ONLY if composite score >= 8. Otherwise verdict = "learn".`,
  ].filter(Boolean).join("\n");
  try {
    const v = await askJson({
      tier: "light",
      role: "judge",
      system: SYSTEM,
      prompt,
      schema: PreShipVerdict,
      maxTokens: 1500,
    });
    // Enforce the floor server-side too: a bad LLM might set verdict=ship on a low score.
    if (v.score < 8 && v.verdict === "ship") v.verdict = "learn";
    if (v.score >= 8 && v.verdict === "learn") v.verdict = "ship";
    return v;
  } catch (e) {
    console.warn(`[pre-ship-scorer] failed: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}

export const SHIP_SCORE_FLOOR = 8;
