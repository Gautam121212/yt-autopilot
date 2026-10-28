/**
 * Clipper M8.2 — LLM narrative-type classifier. Per spec section 4: "Use a scoring model that
 * considers hook strength, narrative coherence, novelty, emotional intensity, payoff, standalone
 * clarity, and visual suitability." Run on the top-K candidates AFTER signal-based ranking (so
 * we only burn LLM calls on real contenders).
 *
 * Takes a video's title + description + top-comment snippets + duration. Returns:
 *   - type: challenge | experiment | competition | reaction | skill-demo | storytelling | reveal | filler
 *   - hookStrength / novelty / payoff / standalone-clarity: 0-10 each
 *   - viralRating: 0-100 composite
 *   - rationale: short string
 *
 * We use the "judge" role so it goes to a lighter / faster provider (per llm.ts routing).
 * Fallback: if no LLM key or the call fails, this returns null and the ranker proceeds without
 * the signal (honest "unavailable" rather than fabricated score).
 */
import { z } from "zod";
import { askJson } from "../llm.js";

export const NarrativeVerdict = z.object({
  type: z.enum(["challenge", "experiment", "competition", "reaction", "skill-demo", "storytelling", "reveal", "comedy", "stunt", "filler"]),
  hookStrength: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10),
  payoff: z.number().min(0).max(10),
  standaloneClarity: z.number().min(0).max(10),
  emotionalIntensity: z.number().min(0).max(10),
  /** M12.2 — topicality: is the content still fresh TODAY? Breakdowns, previews, predictions,
   *  reactions to upcoming events (movie trailers, award shows, elections) decay fast. A trailer
   *  breakdown for a film that already released is near-worthless to a short-form viewer. */
  topicality: z.number().min(0).max(10),
  viralRating: z.number().min(0).max(100),
  shouldClip: z.boolean(),
  rationale: z.string().max(400),
});
export type NarrativeVerdict = z.infer<typeof NarrativeVerdict>;

const SYSTEM = `You are a short-form video editor evaluating whether a long-form YouTube video is worth clipping.
You score across 8 narrative dimensions and give a single composite viralRating (0-100).

Scoring rubric:
- hookStrength: does the opening 10 seconds grab attention? (0 = inert; 10 = can't stop watching)
- novelty: have viewers seen this exact thing a million times already?
- payoff: is there a clear reward (reveal, outcome, punchline) within clip range?
- standaloneClarity: can a stranger understand this without the surrounding video?
- emotionalIntensity: joy, shock, anger, suspense, triumph — any strong feeling?
- topicality: is the content still fresh TODAY (date given in the prompt)? A trailer breakdown for
  a movie that already released is topicality=1. A reaction to a news event from 6 months ago is
  topicality=1-2. A preview of something still upcoming next month is topicality=9-10. Also:
  election coverage after the election, award predictions after the ceremony, "what to expect
  from X" where X already happened — all topicality 1-3. REDUCE viralRating substantially for
  low topicality — a stale take is worthless on short-form.
- viralRating: 0-100 composite; penalize lifestyle-vlog filler regardless of channel size, and
  penalize low topicality heavily. A technically strong clip with topicality<=3 should not score
  above 50.
- shouldClip: your binary call — would YOU make a short out of this? Set FALSE if topicality<=3.

Content type labels — pick the dominant one:
  challenge | experiment | competition | reaction | skill-demo | storytelling | reveal | comedy | stunt | filler

"filler" includes: daily routines, GRWM, cooking vlogs, decor tours, chat-only podcast segments with no reveal.
NEVER inflate scores to avoid saying "filler". The user's spec explicitly rejects ordinary daily content.
Output JSON only, no prose outside it.`;

function userPrompt(input: {
  title: string;
  channel: string;
  description: string;
  durationSec: number;
  viewCount: number;
  publishedAt?: string;
  commentSample?: string[];
}): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `TODAY'S DATE: ${today}`,
    input.publishedAt ? `Video published: ${input.publishedAt.slice(0, 10)}` : "",
    `Title: ${input.title}`,
    `Channel: ${input.channel}`,
    `Duration: ${(input.durationSec / 60).toFixed(1)} min`,
    `View count: ${input.viewCount.toLocaleString()}`,
    `Description (first 500 chars): ${input.description.slice(0, 500)}`,
    input.commentSample?.length ? `Top comments:\n${input.commentSample.slice(0, 5).map((c) => "  - " + c.slice(0, 160)).join("\n")}` : "",
    ``,
    `Score the above against the rubric. Pay EXPLICIT attention to topicality given TODAY'S DATE above.`,
    `Return JSON matching the schema.`,
  ].filter(Boolean).join("\n");
}

/** Classify one video. Returns null if the LLM call fails for ANY reason — caller must treat
 *  null as "signal unavailable" per spec rule, NOT fabricate a score. */
export async function classifyNarrative(input: {
  title: string;
  channel: string;
  description: string;
  durationSec: number;
  viewCount: number;
  publishedAt?: string;
  commentSample?: string[];
}): Promise<NarrativeVerdict | null> {
  try {
    const v = await askJson({
      tier: "light",
      role: "judge",
      system: SYSTEM,
      prompt: userPrompt(input),
      schema: NarrativeVerdict,
      maxTokens: 1200,
    });
    return v;
  } catch (e) {
    console.warn(`[narrative-classifier] ${input.title.slice(0, 60)} — failed: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}
