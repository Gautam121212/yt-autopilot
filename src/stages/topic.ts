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

${providerSupportsWeb() ? "Use at most 3 web searches to confirm the topic is well documented and to spot angles already overdone.\n" : "You have no web access: choose a topic that will be well covered on Wikipedia, and give wikipediaQueries that will actually match article titles.\n"}SCORE each of your 5 candidates 0-10 on: curiosity (would a stranger stop scrolling AND want to retell it),
evidence (documented in encyclopedic sources), illustratability (how many scenes could be real photos or stock
FOOTAGE of concrete things), freshness (unlike our past videos and unlike the outlier list).
Also state, for the chosen topic, the single funniest TRUE detail in it — if you cannot name one, pick a different
topic, because this channel cannot carry a topic that is only worthy.

MINIMUM BARS — a topic that fails any of these must be rejected, even if it is the best of the five:
curiosity >= 7, evidence >= 7, illustratability >= 7, freshness >= 6.
If all five candidates fail, search again with different queries and pick from a new set.
List every rejected candidate with which bar it failed.
JSON: { "chosen": { "workingTitle", "subject", "angle", "hook", "mentalModel", "demandEvidence", "scores": { "curiosity", "evidence", "illustratability", "freshness" }, "wikipediaQueries": [2-4 search terms for Wikipedia] }, "rejected": [{ "workingTitle", "reason" }] }`,
  });
  const sc = topic.chosen.scores;
  const failed = [
    sc.curiosity < 7 && "curiosity", sc.evidence < 7 && "evidence",
    sc.illustratability < 7 && "illustratability", sc.freshness < 6 && "freshness",
  ].filter(Boolean);
  if (failed.length) throw new Error(`topic "${topic.chosen.workingTitle}" failed its own bars: ${failed.join(", ")} (${JSON.stringify(sc)})`);
  return { sub, structure, topic, outliers };
}
