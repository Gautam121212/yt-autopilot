import { askJson, providerSupportsWeb } from "../lib/llm";
import { wikiPages } from "../lib/sources";
import { DossierSchema, type Dossier, type Topic } from "../types";

export async function research(topic: Topic): Promise<Dossier> {
  const pages = await wikiPages(topic.chosen.wikipediaQueries);
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
Every fact and figure must cite the source ids it came from. Anything the sources describe as hypothesis, estimate or debated goes in "uncertain", never in keyFacts.`,
    prompt: `Topic: ${topic.chosen.subject}
Angle: ${topic.chosen.angle}
Mental model to teach: ${topic.chosen.mentalModel}

SOURCES:
${pages.map((p, i) => `### S${i + 1}: ${p.title} (${p.url})\n${p.text}`).join("\n\n")}

JSON: { "summary", "sources": [{ "id": "S1", "url", "title" }], "keyFacts": [{ "fact", "sourceIds" }] (min 8), "figures": [{ "claim", "value", "sourceIds" }], "mentalModel", "uncertain": [string] }`,
  });
}
