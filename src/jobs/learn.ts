/**
 * Weekly learning loop. Output is a PULL REQUEST (config/playbook.md + config/learned.json),
 * never a silent change: you see what the system wants to change and why before it takes effect.
 * Guardrails: minimum sample size, bounded weight changes, exploration floor.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadChannel, loadLearned, learnedPath, loadPlaybook, ROOT, WORK } from "../config";
import { askJson } from "../lib/llm";
import { closeDb, q } from "../lib/db";
import { log } from "../lib/log";
import type { SceneTiming, Script } from "../types";

const LearnSchema = z.object({
  playbook: z.string().min(200),
  subNicheWeights: z.record(z.number().positive()),
  /** At most one new sub-niche per cycle, and only when the evidence points somewhere specific. */
  newSubNiche: z.object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    label: z.string(),
    weight: z.number().min(0.3).max(1),
    adRisk: z.enum(["low", "medium", "high"]),
    examples: z.array(z.string()).min(1).max(3),
    searchQueries: z.array(z.string()).min(2).max(4),
    policyCheck: z.string().describe("why this topic area is safely monetizable and not advice/medical/shock content"),
    rationale: z.string(),
  }).nullable(),
  retireSubNiche: z.object({ id: z.string(), rationale: z.string() }).nullable(),
  cadence: z.object({
    maxVideosPerWeek: z.number().int().min(1).max(7),
    rationale: z.string(),
  }),
  qualityVerdict: z.string().describe("is quality rising, flat or falling, and on what evidence"),
  rationale: z.string(),
  experimentsNext: z.array(z.string()).max(3),
});

type Row = {
  id: number; sub_niche: string; structure: string; title: string; script: Script; scene_timings: SceneTiming[];
  publish_slot: { dow: number; hour: number } | null; publish_at: string; predicted_score: string | null; assets: { review?: { overall: number; decision: string; scores: Record<string, number>; issues: { severity: string; what: string }[] } } | null;
  views_7d: string; avg_pct: string | null; subs_7d: string; likes_7d: string;
};

function retentionSummary(ret: { elapsed_ratio: string; watch_ratio: string }[], timings: SceneTiming[]) {
  if (!ret.length || !timings?.length) return null;
  const total = timings[timings.length - 1]!.end;
  const pts = ret.map((r) => ({ x: Number(r.elapsed_ratio), y: Number(r.watch_ratio) })).sort((a, b) => a.x - b.x);
  const at = (sec: number) => pts.reduce((best, p) => (Math.abs(p.x - sec / total) < Math.abs(best.x - sec / total) ? p : best)).y;
  const sceneAt = (x: number) => timings.find((t) => x * total >= t.start && x * total < t.end)?.sceneId ?? "end";
  const drops = pts.slice(1).map((p, i) => ({ sceneId: sceneAt(p.x), drop: pts[i]!.y - p.y })).sort((a, b) => b.drop - a.drop).slice(0, 3);
  return { at30s: at(30), atHalf: at(total / 2), steepestDrops: drops };
}

async function main() {
  const cfg = loadChannel();
  const rows = await q<Row>(`
    select v.id, v.sub_niche, v.structure, v.title, v.script, v.scene_timings, v.publish_slot, v.publish_at, v.assets, v.predicted_score,
      coalesce(sum(m.views) filter (where m.day < (v.publish_at at time zone 'UTC')::date + 7), 0) as views_7d,
      avg(m.avg_view_pct) as avg_pct,
      coalesce(sum(m.subs_gained) filter (where m.day < (v.publish_at at time zone 'UTC')::date + 7), 0) as subs_7d,
      coalesce(sum(m.likes) filter (where m.day < (v.publish_at at time zone 'UTC')::date + 7), 0) as likes_7d
    from videos v left join metrics_daily m on m.video_id = v.id
    where v.status = 'published' and v.publish_at < now() - interval '7 days'
    group by v.id order by v.id desc limit 60`);

  if (rows.length < cfg.learning.minVideosForLearning) {
    return log(`only ${rows.length} mature videos (< ${cfg.learning.minVideosForLearning}); not learning from noise yet`);
  }

  const videos = [];
  for (const r of rows) {
    const ret = await q<{ elapsed_ratio: string; watch_ratio: string }>("select elapsed_ratio, watch_ratio from retention where video_id = $1", [r.id]);
    videos.push({
      id: r.id, subNiche: r.sub_niche, structure: r.structure, title: r.title,
      hook: r.script.scenes[0]?.narration, minutes: r.scene_timings?.length ? +(r.scene_timings.at(-1)!.end / 60).toFixed(1) : null,
      views7d: Number(r.views_7d), avgViewPct: r.avg_pct ? Number(Number(r.avg_pct).toFixed(1)) : null,
      subs7d: Number(r.subs_7d), likes7d: Number(r.likes_7d),
      slot: r.publish_slot, publishedAt: r.publish_at,
      predictedScore: r.predicted_score != null ? Number(r.predicted_score) : null,
      preReleaseScore: r.assets?.review?.overall ?? null,
      preReleaseScores: r.assets?.review?.scores ?? null,
      preReleaseIssues: (r.assets?.review?.issues ?? []).map((i) => `${i.severity}: ${i.what}`.slice(0, 120)),
      retention: retentionSummary(ret, r.scene_timings),
    });
  }
  const incidents = await q("select stage, count(*)::int as n, max(message) as example from incidents where created_at > now() - interval '30 days' group by stage order by n desc limit 15");
  // Per-slot and per-sub-niche view averages, so the playbook can reason about WHEN as well as WHAT.
  const bySlot = await q(`
    select v.sub_niche, (v.publish_slot->>'dow')::int as dow, (v.publish_slot->>'hour')::int as hour,
           count(*)::int as videos, round(avg(x.views))::int as avg_views_48h
    from videos v join lateral (
      select coalesce(sum(m.views), 0) as views from metrics_daily m
      where m.video_id = v.id and m.day <= (v.publish_at at time zone 'UTC')::date + 1
    ) x on true
    where v.status = 'published' and v.publish_slot is not null
    group by 1, 2, 3 order by avg_views_48h desc`);
  const heldBack = await q(`
    select title, assets->'review'->>'overall' as score, assets->'review'->>'noteForOwner' as note
    from videos where status in ('awaiting_approval','rejected','abandoned') order by id desc limit 10`);
  const rejections = await q("select title, rejection_reason from videos where status = 'rejected' and updated_at > now() - interval '60 days' limit 20");
  const oldWeights = Object.fromEntries(cfg.subNiches.map((s) => [s.id, s.weight]));

  const out = await askJson({
    tier: "heavy",
    schema: LearnSchema,
    system: `You are the channel's data-driven showrunner. You update the writing playbook from evidence.
You see, for every video: pre-release quality scores from the final check, 7-day views/watch/likes/subs,
the retention curve with the scene at each steep drop, which publish slot it used, and the pipeline's own incidents.

Your job is three things at once:
1. WRITING RULES — what makes this channel's videos hold attention (from retention drops + scores).
2. WHAT TO MAKE — sub-niche weights (from views and subscribers gained per sub-niche).
3. WHEN TO PUBLISH — say plainly in the rationale which slots look better for which sub-niches, and flag any slot
   that should be dropped. Never claim a timing effect from fewer than 4 videos in that slot.

You also see predictedScore (estimated before production) next to preReleaseScore (what the reviewer gave).
If predictions run consistently high, say so in qualityVerdict — that means topics are being approved that
should have been abandoned, and the topic bars in the playbook need raising.

Also compare pre-release scores against actual performance: if videos the final check scored 8+ underperform,
say so, because that means the check is measuring the wrong thing.

EXPANSION — you may propose ONE new sub-niche per cycle, and you are expected to keep widening the channel's
range over time rather than settling early: a channel with more proven topic areas has more ways to grow. Propose one only when the data points somewhere
specific (a sub-niche outperforming, a retention pattern, a demand signal), never to "try something new".
A new sub-niche must: be explainable from encyclopedic sources; be illustratable with real archive photographs;
be advertiser-safe; and contain no advice. Reject anything that would breach YouTube's rules for monetization:
- inauthentic/mass-produced or templated content, or anything a viewer could not tell apart from the last video;
- misinformation, pseudoscience stated as fact, or contested science presented as settled;
- medical, psychological, legal or financial advice, or "signs you have X" framing;
- shocking, violent, tragedy-exploiting or sensational framing;
- content aimed at children, or anything that would flag "made for kids";
- claims about real named living people.
Say in policyCheck why the area is safe on every one of those points.

CADENCE — recommend maxVideosPerWeek. More videos only if quality is holding: median pre-release score >= 7.5,
few holds, no recurring quality incidents. If quality is slipping, recommend fewer. Code enforces a +/-1 limit
and a hard ceiling, so argue the direction, not the number.

RETIREMENT — you may propose retiring one sub-niche that has at least 4 videos and clearly underperforms on
views AND retention. Never propose retiring one you have little data on.

Statistical discipline:
- Views are dominated by topic; with small samples most differences are noise. Only promote a rule to [Likely] with a consistent pattern across >= 4 videos; cite video ids for every rule.
- Retention drops at specific scenes are the most actionable signal: turn them into concrete writing rules.
- Keep seed [Hypothesis] rules unless evidence contradicts them. Delete rules the evidence contradicts.
- Keep the playbook under 900 words. Never add rules that conflict with accuracy, legal caution or YouTube policy.
- Human rejection reasons outrank metrics.`,
    prompt: `CURRENT PLAYBOOK:\n${loadPlaybook()}\n\nCURRENT SUB-NICHE WEIGHTS:\n${JSON.stringify(oldWeights)}\n\nVIDEOS (7-day metrics):\n${JSON.stringify(videos)}\n\nAVERAGE FIRST-48H VIEWS BY SLOT AND SUB-NICHE:\n${JSON.stringify(bySlot)}\n\nHELD OR REJECTED BEFORE RELEASE:\n${JSON.stringify(heldBack)}\n\nRECURRING PIPELINE INCIDENTS (30d):\n${JSON.stringify(incidents)}\n\nHUMAN REJECTIONS:\n${JSON.stringify(rejections)}\n\nReturn {
 "playbook": full new markdown,
 "subNicheWeights": { id: weight },
 "newSubNiche": null or { "id" (lowercase_underscores), "label", "weight" (0.3-1), "adRisk", "examples" [1-3], "searchQueries" [2-4 YouTube search phrases for demand data], "policyCheck", "rationale" },
 "retireSubNiche": null or { "id", "rationale" },
 "cadence": { "maxVideosPerWeek", "rationale" },
 "qualityVerdict": is quality rising, flat or falling and on what evidence,
 "rationale": what changed and why, citing video ids,
 "experimentsNext": up to 3 deliberate tests for next cycle
}`,
  });

  // ---- Guardrails. The model proposes; these rules decide. ----
  const scores = videos.map((v) => v.preReleaseScore).filter((n): n is number => typeof n === "number");
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);
  const published = rows.length;
  const [{ n: heldCount }] = await q<{ n: number }>("select count(*)::int as n from videos where status in ('awaiting_approval','rejected','abandoned') and updated_at > now() - interval '30 days'");
  const [{ n: policyIncidents }] = await q<{ n: number }>("select count(*)::int as n from incidents where created_at > now() - interval '30 days' and (stage like 'verify%' or stage like 'image-qa%' or stage like 'visuals.weak%')");
  const medianScore = median(scores);
  const heldShare = published + heldCount ? heldCount / (published + heldCount) : 1;

  // Cadence may move by at most 1 per cycle, and only upward when quality is actually holding up.
  const current = cfg.maxVideosPerWeek;
  const mayIncrease = published >= 8 && medianScore >= 7.5 && heldShare <= 0.35 && policyIncidents < 5;
  const mustDecrease = published >= 6 && (medianScore < 6 || heldShare > 0.6);
  let cadence = current;
  if (mustDecrease) cadence = Math.max(1, current - 1);
  else if (mayIncrease && out.cadence.maxVideosPerWeek > current) cadence = Math.min(cfg.learning.cadenceCeiling, current + 1);
  else if (out.cadence.maxVideosPerWeek < current) cadence = Math.max(1, current - 1);

  // Bound weight changes: no single noisy week can starve or flood a sub-niche.
  const maxStep = cfg.learning.maxWeightChangePerCycle;
  const weights: Record<string, number> = {};
  for (const [id, old] of Object.entries(oldWeights)) {
    const proposed = out.subNicheWeights[id] ?? old;
    weights[id] = +Math.min(3, Math.max(0.3, Math.min(old * (1 + maxStep), Math.max(old * (1 - maxStep), proposed)))).toFixed(2);
  }

  // Expansion: one new sub-niche per cycle, capped overall, and only once there is a baseline to compare against.
  const learned = loadLearned();
  const added = [...(learned.addedSubNiches ?? [])];
  let expansionNote = "no change";
  if (out.newSubNiche && published >= 6 && added.length < cfg.learning.maxLearnedSubNiches
      && !cfg.subNiches.some((s) => s.id === out.newSubNiche!.id)) {
    const { policyCheck, rationale, ...niche } = out.newSubNiche;
    added.push({ ...niche, weight: Math.min(0.8, niche.weight) }); // starts small: it is an experiment
    expansionNote = `added "${niche.id}" — ${rationale} (policy: ${policyCheck})`;
  }
  const retired = new Set(learned.retiredSubNiches ?? []);
  if (out.retireSubNiche && cfg.subNiches.length - retired.size > 4) {
    const n = videos.filter((v) => v.subNiche === out.retireSubNiche!.id).length;
    if (n >= 4) { retired.add(out.retireSubNiche.id); expansionNote += `; retired "${out.retireSubNiche.id}"`; }
  }

  await fs.writeFile(path.join(ROOT, "config/playbook.md"), out.playbook.trim() + "\n");
  await fs.writeFile(learnedPath(), JSON.stringify({
    subNicheWeights: weights,
    maxVideosPerWeek: cadence,
    addedSubNiches: added,
    retiredSubNiches: [...retired],
    updatedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  await q("insert into playbook_versions (content, weights, rationale) values ($1, $2, $3)", [out.playbook, JSON.stringify(weights), out.rationale]);
  await fs.mkdir(WORK, { recursive: true });
  await fs.writeFile(path.join(WORK, "learn-summary.md"), [
    `## Quality verdict\n${out.qualityVerdict}`,
    `## Why these changes\n${out.rationale}`,
    `## Cadence\n${current} -> **${cadence}** videos/week (model asked for ${out.cadence.maxVideosPerWeek}; ceiling ${cfg.learning.cadenceCeiling})\n`,
    `Gate: ${published} mature videos, median pre-release score ${medianScore.toFixed(1)}, ${(heldShare * 100).toFixed(0)}% held/rejected, ${policyIncidents} quality incidents.`,
    `Raise allowed only at 8+ videos, median score >= 7.5, <= 35% held, < 5 incidents.`,
    `## Topic areas\n${expansionNote}`,
    `## Weights\n\`\`\`json\n${JSON.stringify({ before: oldWeights, after: weights }, null, 2)}\n\`\`\``,
    `## Experiments next cycle\n${out.experimentsNext.map((e) => `- ${e}`).join("\n")}`,
    `Based on ${videos.length} videos with 7+ days of data.`,
  ].join("\n\n"));
  log(`learning cycle done: cadence ${current} -> ${cadence}; ${expansionNote}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closeDb);
