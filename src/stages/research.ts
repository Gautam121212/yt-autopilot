import { askJson, providerSupportsWeb } from "../lib/llm";
import { wikiPages } from "../lib/sources";
import { DossierSchema, type Dossier, type Topic } from "../types";

export async function research(topic: Topic): Promise<Dossier> {
  // More pages: a funny, specific script needs far more raw material than a dry summary does.
  const pages = await wikiPages(topic.chosen.wikipediaQueries, 20000);
  if (pages.length < 2) throw new Error(`only ${pages.length} Wikipedia pages found for ${topic.chosen.wikipediaQueries.join(", ")}`);
  const web = providerSupportsWeb();
  return askJson({
    tier: "light",
    web,
    schema: DossierSchema,
    system: `You are a meticulous research producer for an educational channel.
${web
  ? `Use the source texts below plus pages you open yourself with WebFetch/WebSearch. Add up to 4 authoritative web sources (nasa.gov, jpl.nasa.gov, esa.int, universities, peer-reviewed journals, major science outlets) that add facts or newer numbers; id them after the provided ones. Where sources disagree, prefer the most recent authoritative one and note the disagreement in "uncertain".`
  : `Use ONLY the source texts provided below. You have no web access: never invent a URL and never add a source that is not listed below. Facts you merely remember do not belong here.`}
Every fact and figure must cite the source ids it came from. Anything the sources describe as hypothesis, estimate or debated goes in "uncertain", never in keyFacts.

COLLECT NARRATIVE COLOUR — this is as important as the figures. The writer tells these stories with specifics,
and if you do not supply them it will invent them and the fact-checker will destroy the script. From the sources,
pull at least 6 concrete "details": who was present and what they were doing, the time of day, what people saw or
heard, the exact objects involved, what someone said, how long something took, what happened to the equipment,
the absurd bureaucratic aftermath. Each one cited. If a detail is not in the sources, leave it out — but look hard,
because encyclopedic articles usually carry more of this than a summary suggests.`,
    prompt: `Topic: ${topic.chosen.subject}
Angle: ${topic.chosen.angle}
Mental model to teach: ${topic.chosen.mentalModel}

SOURCES:
${pages.map((p, i) => `### S${i + 1}: ${p.title} (${p.url})\n${p.text}`).join("\n\n")}

JSON: { "summary", "sources": [{ "id": "S1", "url", "title" }], "keyFacts": [{ "fact", "sourceIds" }] (min 8), "figures": [{ "claim", "value", "sourceIds" }], "mentalModel",
 "details": [{ "detail", "sourceIds" }] (min 6, concrete narrative specifics),
 "uncertain": [string] }`,
  });
}
