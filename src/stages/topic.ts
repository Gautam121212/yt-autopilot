import type { ChannelConfig, SubNicheT } from "../config";
import { askJson, providerSupportsWeb } from "../lib/llm";
import { q } from "../lib/db";
import { incident } from "../lib/log";
import { findOutliers, type Outlier } from "../lib/sources";
import { TopicSchema, type Topic } from "../types";

function weightedPick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const i of items) if ((r -= i.weight) <= 0) return i;
  return items[items.length - 1]!;
}
const shuffle = <T>(a: T[]) => [...a].sort(() => Math.random() - 0.5);

export async function pickTopic(cfg: ChannelConfig, forcedSubNiche?: string) {
  const sub: SubNicheT = forcedSubNiche
    ? (cfg.subNiches.find((s) => s.id === forcedSubNiche) ?? (() => { throw new Error(`unknown sub-niche ${forcedSubNiche}`); })())
    : weightedPick(cfg.subNiches);

  // Rotate structures so uploads don't look templated (inauthentic-content policy).
  const recent = await q<{ structure: string }>("select structure from videos order by id desc limit 6");
  const counts = new Map(cfg.structures.map((s) => [s.id, 0]));
  for (const r of recent) counts.set(r.structure, (counts.get(r.structure) ?? 0) + 1);
  const minCount = Math.min(...counts.values());
  const structure = shuffle(cfg.structures.filter((s) => counts.get(s.id) === minCount))[0]!;

  // Demand signal: recent videos that beat their channel size by a wide margin.
  let outliers: Outlier[] = [];
  try {
    if (process.env.SKIP_DEMAND_SEARCH === "true") throw new Error("demand search skipped by request");
    outliers = await findOutliers(shuffle(sub.searchQueries).slice(0, cfg.discovery.queriesPerRun), cfg.discovery.lookbackDays, cfg.discovery.minViews);
  } catch (e) {
    await incident("topic.outliers", e); // keep going without demand data rather than fail the run
  }

  const past = await q<{ t: string }>(
    "select coalesce(title, topic->'chosen'->>'workingTitle') as t from videos where status not in ('failed') order by id desc limit 300",
  );

  const topic: Topic = await askJson({
    tier: "light",
    web: providerSupportsWeb(),
    schema: TopicSchema,
    system: `You are the editorial lead of "${cfg.channelName}", a YouTube channel: ${cfg.niche}.
You choose topics with PROVEN audience demand, then find an angle that is genuinely different from what already exists.
Rules: the topic must be explainable accurately from Wikipedia-level sources and must be ILLUSTRATABLE with real
archive photographs (concrete objects, places, artefacts, organisms, machines). No pseudoscience presented as fact;
no doom or fear-mongering framing; no topic that invites the viewer to self-diagnose or that reads as medical,
psychological, legal or financial advice (a psychology topic must be about documented research, never about "signs you have X");
no topic centred on a living private individual;
no copying another creator's title or angle.`,
    prompt: `Sub-niche: ${sub.label}. Example directions: ${sub.examples.join("; ")}.
Narrative structure to be used: ${structure.id} - ${structure.description}

DEMAND DATA - recent videos that outperformed their channel size (ratio = views / subscribers; higher = topic did the work):
${outliers.length ? outliers.map((o) => `- "${o.title}" | ${o.views.toLocaleString()} views | ${o.subs.toLocaleString()} subs | ratio ${o.ratio} | ${o.ageDays}d old`).join("\n") : "(no demand data this run - rely on evergreen curiosity)"}

ALREADY COVERED (do not repeat or closely overlap):
${past.map((p) => `- ${p.t}`).join("\n") || "- (nothing yet)"}

${providerSupportsWeb() ? "Use at most 3 web searches to confirm the topic is well documented and to spot angles already overdone.\n" : "You have no web access: choose a topic that will be well covered on Wikipedia, and give wikipediaQueries that will actually match article titles.\n"}SCORE each of your 5 candidates 0-10 on SIX axes:
- absurdity: how indefensible, reckless or ridiculous the true events are
- retellability: would a viewer repeat this to someone within a day
- curiosity: would a stranger stop scrolling
- evidence: how well documented in encyclopedic sources
- illustratability: could STOCK FOOTAGE and archive photos of generic concrete things cover it
- freshness: unlike our past videos and unlike the outlier list

PASS GATE — a candidate that fails ANY of these is rejected outright, even if it is the best of the five:
absurdity >= 7, retellability >= 7, curiosity >= 7, evidence >= 7, illustratability >= 7, freshness >= 6.
You must also supply, for the chosen topic:
- funniestDetail: the single funniest TRUE thing in it, in one sentence. No funny detail, no topic.
- premise: the whole video in one sentence a stranger would repeat at a dinner table.
- visualSubjects: 8-12 CONCRETE, FILMABLE things this story can be shown with, each 2-4 words.
  These are checked against real stock libraries before anything else is written, so name things a
  camera has definitely pointed at: "welding sparks", "steam valve", "cargo ship deck", "glass beaker",
  "mine shaft", "old ledger", "storm clouds", "hands on lever".
  NOT: "1888 inspection certificate", "Beaumont's patient", "the committee's decision", "public outrage".
  A topic whose story cannot be shown with generic footage is the wrong topic, however funny it is.
If all five candidates fail, search again with different queries and score a fresh set.

A passing "chosen" looks like this (shape, not content):
{
  "workingTitle": "The Man Who Ate a Plane to Prove a Point",
  "subject": "...", "angle": "...", "hook": "...", "mentalModel": "...", "demandEvidence": "...",
  "funniestDetail": "He filed the receipts as a business expense.",
  "premise": "A French entertainer ate an entire aircraft over two years, and doctors could not explain why he survived.",
  "visualSubjects": ["scrap metal pile", "hospital x-ray", "small aeroplane", "workshop grinder",
                     "metal filings", "old newspaper page", "stomach diagram", "hangar interior"],
  "scores": { "absurdity": 9, "retellability": 9, "curiosity": 8, "evidence": 8, "illustratability": 8, "freshness": 8 },
  "wikipediaQueries": ["..."]
}
Every field is REQUIRED. Return all of them for the chosen topic.

MINIMUM BARS — a topic that fails any of these must be rejected, even if it is the best of the five:
curiosity >= 7, evidence >= 7, illustratability >= 7, freshness >= 6.
If all five candidates fail, search again with different queries and pick from a new set.
List every rejected candidate with which bar it failed.
JSON: { "chosen": { "workingTitle", "subject", "angle", "hook", "mentalModel", "demandEvidence", "scores": { "curiosity", "evidence", "illustratability", "freshness" }, "wikipediaQueries": [2-4 search terms for Wikipedia] }, "rejected": [{ "workingTitle", "reason" }] }`,
  });
  // Hard pass gate. A topic that fails any bar is not this channel's topic, however good it looks.
  const sc = topic.chosen.scores;
  const failed = [
    sc.absurdity < 7 && "absurdity (nothing indefensible happens)",
    sc.retellability < 7 && "retellability (nobody would repeat this)",
    sc.curiosity < 7 && "curiosity",
    sc.evidence < 7 && "evidence",
    sc.illustratability < 7 && "illustratability (stock footage cannot cover it)",
    sc.freshness < 6 && "freshness",
    topic.chosen.funniestDetail.length < 20 && "no funniest true detail named",
  ].filter(Boolean);
  if (failed.length) throw new Error(`topic "${topic.chosen.workingTitle}" failed its own bars: ${failed.join(", ")} (${JSON.stringify(sc)})`);
  return { sub, structure, topic, outliers };
}
