/**
 * Before a single second of voice or render is spent, estimate the best rating this script could
 * realistically earn from the final check, and why it would fall short. Cheap text call, saves
 * ~25 minutes of CPU on scripts that were never going to pass.
 */
import { z } from "zod";
import type { ChannelConfig } from "../config";
import { askJson } from "../lib/llm";
import type { Dossier, Script } from "../types";

export const ForecastSchema = z.object({
  ceiling: z.number().min(0).max(10).describe("best score this script could earn if every image lands perfectly"),
  likely: z.number().min(0).max(10).describe("score you actually expect, given typical image results"),
  scores: z.object({ hook: z.number(), clarity: z.number(), packaging: z.number(), illustratability: z.number() }),
  weakest: z.string(),
  fixes: z.array(z.object({
    area: z.enum(["script", "title", "thumbnail", "image"]),
    sceneId: z.string().nullable(),
    what: z.string(),
    fix: z.string(),
    severity: z.enum(["blocker", "major", "minor"]),
  })).max(8),
  verdict: z.enum(["proceed", "repair", "abandon"]),
});
export type Forecast = z.infer<typeof ForecastSchema>;

export async function forecast(o: {
  cfg: ChannelConfig; script: Script; dossier: Dossier;
  history: { predicted: number; actual: number }[];
  /** share of scenes with a findable archive picture, measured against the real archive */
  feasible: number;
}): Promise<Forecast> {
  // Calibration: if past predictions ran high, the model is told so and should mark itself down.
  // Needs a real sample, and the nudge is capped: a couple of bad videos must not make every
  // future script look hopeless (that is how a pipeline talks itself into producing nothing).
  const raw = o.history.length >= 4
    ? o.history.reduce((n, h) => n + (h.predicted - h.actual), 0) / o.history.length
    : 0;
  const bias = Math.max(-1.5, Math.min(1.5, raw));

  return askJson({
    tier: "heavy",
    schema: ForecastSchema,
    system: `You predict how a finished video will be rated, from its script alone, before it is produced.
The reviewer who will actually rate it scores like this: 10 = would send to a friend, 8 = would watch to the end,
6 = would click away at the midpoint, 5 or below = competent but forgettable. It auto-holds for: an unsupported
claim, a weak or generic first 20 seconds, encyclopedia-flavoured writing, advice or self-diagnosis framing,
a title that overpromises, or scenes that cannot be illustrated with a real archive photograph.

Illustratability is MEASURED, not guessed: ${Math.round(o.feasible * 100)}% of this script's scenes returned a
genuinely matching picture when searched against Wikimedia Commons. Production additionally searches Openverse,
Pexels and NASA, so true coverage is typically higher than this figure — treat it as a floor, not a ceiling. The rest will be rendered as designed
typographic cards built from each scene's own cardHeadline/cardSub — relevant by construction, never a wrong
photograph. So score visualsMatch on the MIX: a video that is mostly real photographs with a few cards reads as
deliberate; one that is more than half cards reads as a slideshow of text and cannot exceed 6.
Judge the cardHeadline values too: a card carrying a concrete figure works, a card repeating an abstraction does not.

verdict: "proceed" if likely >= 7; "repair" if the listed fixes would plausibly get it there; "abandon" if the
topic itself cannot carry a good video (thin sourcing, nothing surprising, nothing to show).${
  bias > 0.4 ? `\n\nCALIBRATION: recent predictions ran about ${bias.toFixed(1)} points generous. Shade down by roughly that much — no more.`
  : bias < -0.4 ? `\n\nCALIBRATION: recent predictions ran about ${Math.abs(bias).toFixed(1)} points harsh. Shade up by roughly that much — no more.` : ""}`,
    prompt: `SCRIPT:\n${JSON.stringify(o.script)}\n\nDOSSIER (what can be supported):\n${JSON.stringify(o.dossier)}${
      o.history.length ? `\n\nYOUR PAST PREDICTIONS vs WHAT THE REVIEWER ACTUALLY GAVE:\n${JSON.stringify(o.history)}` : ""}`,
  });
}
