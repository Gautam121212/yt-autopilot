import { askJson } from "../lib/llm";
import { VerifySchema, type Dossier, type Script, type Verification } from "../types";

export async function verify(script: Script, dossier: Dossier, recentTitles: string[]): Promise<Verification> {
  const v = await askJson({
    tier: "heavy",
    schema: VerifySchema,
    system: `You are an independent standards editor. You did not write this script and gain nothing by passing it.
Check the long script AND the short against the dossier and YouTube's rules. Be specific; cite scene ids.

CHECKLIST
- factual: every number, date, name traceable to the dossier; no inflated figures; no outside claims.
- misinformation: hypotheses or dossier.uncertain items presented as settled fact; pseudoscience; fear-mongering (e.g. "asteroid will destroy Earth").
- misleading_metadata: title, alt titles, thumbnail text and short title accurately reflect the content.
- advertiser_friendly: shock or disaster framing, graphic descriptions of death.
- inauthentic_risk: does it add original explanation (comparisons, mental model, synthesis), or is it a reworded Wikipedia article? Too similar to: ${recentTitles.join(" | ") || "none"}?
- quality: weak hook, flat middle, missing payoff, repetition, imageQuery values that are abstract, name a living person, or could not exist as a real photograph.

Verdict: "pass" only with no blocker/major issues. "abandon" if the topic can't be done accurately from this dossier.`,
    prompt: `DOSSIER:\n${JSON.stringify(dossier)}\n\nSCRIPT:\n${JSON.stringify(script)}\n\nJSON: { "verdict": "pass"|"revise"|"abandon", "adSuitability": "likely_full"|"likely_limited"|"unsuitable", "issues": [{ "sceneId": string|null, "category": "factual"|"misinformation"|"misleading_metadata"|"advertiser_friendly"|"inauthentic_risk"|"quality", "severity": "blocker"|"major"|"minor", "problem", "fix" }], "summary" }`,
  });
  const serious = v.issues.some((i) => i.severity !== "minor");
  if (v.verdict === "pass" && (serious || v.adSuitability === "unsuitable")) v.verdict = "revise";
  return v;
}
