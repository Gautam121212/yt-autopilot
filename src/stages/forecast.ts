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

export async function forecast(o: { cfg: ChannelConfig; script: Script; dossier: Dossier; history: { predicted: number; actual: number }[] }): Promise<Forecast> {
  // Calibration: if past predictions ran high, the model is told so and should mark itself down.
  const bias = o.history.length >= 3
    ? o.history.reduce((n, h) => n + (h.predicted - h.actual), 0) / o.history.length
    : 0;

  return askJson({
    tier: "heavy",
    schema: ForecastSchema,
    system: `You predict how a finished video will be rated, from its script alone, before it is produced.
The reviewer who will actually rate it scores like this: 10 = would send to a friend, 8 = would watch to the end,
6 = would click away at the midpoint, 5 or below = competent but forgettable. It auto-holds for: an unsupported
claim, a weak or generic first 20 seconds, encyclopedia-flavoured writing, advice or self-diagnosis framing,
a title that overpromises, or scenes that cannot be illustrated with a real archive photograph.

Score "illustratability" honestly: count how many scenes name a concrete object a photo archive would actually
hold. Abstractions, analogies without a literal object, and events with no photographable subject drag it down,
because those scenes end up with irrelevant pictures and sink the real review.

verdict: "proceed" if likely >= 7; "repair" if the listed fixes would plausibly get it there; "abandon" if the
topic itself cannot carry a good video (thin sourcing, nothing surprising, nothing to show).${
  bias > 0.4 ? `\n\nCALIBRATION: your recent predictions have been ${bias.toFixed(1)} points too generous. Mark down accordingly.`
  : bias < -0.4 ? `\n\nCALIBRATION: your recent predictions have been ${Math.abs(bias).toFixed(1)} points too harsh. Adjust up accordingly.` : ""}`,
    prompt: `SCRIPT:\n${JSON.stringify(o.script)}\n\nDOSSIER (what can be supported):\n${JSON.stringify(o.dossier)}${
      o.history.length ? `\n\nYOUR PAST PREDICTIONS vs WHAT THE REVIEWER ACTUALLY GAVE:\n${JSON.stringify(o.history)}` : ""}`,
  });
}
