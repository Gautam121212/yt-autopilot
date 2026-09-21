import { askJson } from "../lib/llm";
import { BLOCKING_CATEGORIES, VerifySchema, type Dossier, type Script, type Verification } from "../types";

export async function verify(script: Script, dossier: Dossier, recentTitles: string[]): Promise<Verification> {
  const v = await askJson({
    tier: "heavy",
    role: "judge",
    schema: VerifySchema,
    system: `You are an independent standards editor. You did not write this script and gain nothing by passing it.
Check the long script AND the short against the dossier and YouTube's rules. Be specific; cite scene ids.

CHECKLIST
- factual: every number, date, name traceable to the dossier; no inflated figures; no outside claims.
- misinformation: hypotheses or dossier.uncertain items presented as settled fact; pseudoscience; fear-mongering (e.g. "asteroid will destroy Earth").
- misleading_metadata: title, alt titles, thumbnail text and short title accurately reflect the content.
- advertiser_friendly: shock or disaster framing, graphic descriptions of death.
- inauthentic_risk: does it add original explanation (comparisons, mental model, synthesis), or is it a reworded Wikipedia article? Too similar to: ${recentTitles.join(" | ") || "none"}?
- inauthentic_risk: a reworded Wikipedia article with nothing added. Advisory only.

OUT OF SCOPE — do not raise these at all: tone, humour, pacing, word choice, how funny it is, whether
it is "too neutral" or "too dramatic". A separate comedy pass writes the voice and a separate forecast
scores it against a 7.5 bar. A factually accurate, policy-safe script PASSES here even if it is dull.

Verdict: "pass" when there are no blocker/major FACTUAL or POLICY issues. "abandon" ONLY if a claim at the
heart of the story cannot be supported by the dossier at all.`,
    prompt: `DOSSIER:\n${JSON.stringify(dossier)}\n\nSCRIPT:\n${JSON.stringify(script)}\n\nJSON: { "verdict": "pass"|"revise"|"abandon", "adSuitability": "likely_full"|"likely_limited"|"unsuitable", "issues": [{ "sceneId": string|null, "category": "factual"|"misinformation"|"misleading_metadata"|"advertiser_friendly"|"inauthentic_risk"|"quality", "severity": "blocker"|"major"|"minor", "problem", "fix" }], "summary" }`,
  });
  // The verdict is DERIVED from the issues, never taken from the model's say-so. A reviewer that
  // abandoned a script it called "factually accurate" — over tone — is what this prevents.
  const blocking = v.issues.filter((i) => BLOCKING_CATEGORIES.has(i.category) && i.severity !== "minor");
  const advisory = v.issues.filter((i) => !blocking.includes(i));
  const factualBlocker = blocking.some((i) => i.severity === "blocker" && (i.category === "factual" || i.category === "misinformation"));
  const verdict: Verification["verdict"] =
    v.verdict === "abandon" && factualBlocker ? "abandon"
    : blocking.length || v.adSuitability === "unsuitable" ? "revise"
    : "pass";
  // Only blocking issues drive revision: asking the reviser to fix tone as well is what made each
  // round introduce new problems (10 -> 12 -> 11 issues).
  return {
    ...v,
    verdict,
    issues: blocking,
    summary: advisory.length
      ? `${v.summary} [advisory, not blocking: ${advisory.map((i) => i.problem).join("; ").slice(0, 400)}]`
      : v.summary,
  };
}
