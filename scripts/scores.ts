/**
 * Scores dashboard — reverse-engineer the pipeline's own output.
 *
 * Reads review payloads from videos.assets.review (populated by stages/review.ts) and prints a
 * terminal-friendly Markdown report: dimension averages, 7-day-vs-prior-7-day trend, which sub-niches
 * reject most often, and which rejected scripts came closest to clearing the publish bar.
 *
 * This is the "REA for tools" piece — not literal reverse-engineering of binaries, but reverse-
 * engineering of the channel's own quality signal to see WHERE scripts lose points.
 *
 * Usage: `npm run scores` (defaults to 30-day window)
 *        `WINDOW_DAYS=14 npm run scores`
 */
import { closeDb, q } from "../src/lib/db";
import { loadChannel } from "../src/config";

type Dim = "hook" | "clarity" | "visualsMatch" | "thumbnail" | "packaging";
const DIMS: Dim[] = ["hook", "clarity", "visualsMatch", "thumbnail", "packaging"];
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 30);

type Row = {
  id: number; title: string | null; status: string; sub_niche: string;
  updated_at: string;
  hook: string; clarity: string; visualsMatch: string; thumbnail: string; packaging: string;
  overall: string; decision: string;
};

async function pullReviews(sinceDays: number): Promise<Row[]> {
  // No swallowed errors here. The old `.catch(() => [])` turned a DB connection problem OR a
  // schema mismatch into a silent "0 reviews" verdict, which is indistinguishable from "the
  // pipeline hasn't produced anything" — the whole point of the dashboard is to tell you WHICH
  // of those is true. Surface the error so the user can fix the real problem.
  return q<Row>(
    `select v.id, v.title, v.status, v.sub_niche, v.updated_at,
       (assets->'review'->'scores'->>'hook')::numeric         as hook,
       (assets->'review'->'scores'->>'clarity')::numeric      as clarity,
       (assets->'review'->'scores'->>'visualsMatch')::numeric as "visualsMatch",
       (assets->'review'->'scores'->>'thumbnail')::numeric    as thumbnail,
       (assets->'review'->'scores'->>'packaging')::numeric    as packaging,
       (assets->'review'->>'overall')::numeric                as overall,
       (assets->'review'->>'decision')                        as decision
     from videos
     where assets->'review'->'scores' is not null
       and updated_at > now() - ($1 || ' days')::interval
     order by updated_at desc`,
    [String(sinceDays)],
  );
}

/**
 * Diagnostic — when the main query returns 0 rows, count how far each filter stage reduces the
 * row count. Catches cases where the review payload is persisted under a different shape
 * (e.g. `assets.review` with no `scores` field, which can happen if `unreviewed()` is replaced
 * upstream with a lighter object), vs. actually having no rows at all.
 */
type Diag = { stage: string; n: string };
async function diagnose(sinceDays: number): Promise<Diag[]> {
  return q<Diag>(
    `select 'total videos'                               as stage, count(*)::text as n from videos
     union all
     select 'with assets.review'                                      , count(*)::text    from videos where assets ? 'review'
     union all
     select 'with assets.review.scores'                               , count(*)::text    from videos where assets->'review'->'scores' is not null
     union all
     select 'with scores AND updated in window'                       , count(*)::text    from videos where assets->'review'->'scores' is not null and updated_at > now() - ($1 || ' days')::interval
     union all
     select 'rejected status (any window)'                            , count(*)::text    from videos where status in ('rejected','abandoned')
     union all
     select 'published status (any window)'                           , count(*)::text    from videos where status in ('published','uploaded')`,
    [String(sinceDays)],
  );
}

const num = (s: string | number | null): number => (s == null ? NaN : Number(s));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "—");
const bar = (n: number, max = 10, width = 20) =>
  Number.isFinite(n) ? "█".repeat(Math.round((n / max) * width)) + "░".repeat(width - Math.round((n / max) * width)) : "─".repeat(width);

function section(title: string) { return `\n## ${title}\n`; }

function dimAverages(rows: Row[], prevRows: Row[] = []): string {
  const now = Object.fromEntries(DIMS.map((d) => [d, mean(rows.map((r) => num(r[d])).filter(Number.isFinite))])) as Record<Dim, number>;
  const prev = Object.fromEntries(DIMS.map((d) => [d, mean(prevRows.map((r) => num(r[d])).filter(Number.isFinite))])) as Record<Dim, number>;
  const lines = DIMS.map((d) => {
    const delta = Number.isFinite(prev[d]) ? now[d] - prev[d] : NaN;
    const arrow = !Number.isFinite(delta) ? "  " : delta > 0.3 ? "▲ " : delta < -0.3 ? "▼ " : "· ";
    const sign = Number.isFinite(delta) ? (delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)) : "   ";
    return `  ${d.padEnd(13)} ${bar(now[d])} ${fmt(now[d]).padStart(4)}/10  ${arrow}${sign}`;
  });
  return lines.join("\n");
}

function cohortSplit(rows: Row[]): { published: Row[]; rejected: Row[]; other: Row[] } {
  const published: Row[] = []; const rejected: Row[] = []; const other: Row[] = [];
  for (const r of rows) {
    if (r.status === "published" || r.status === "uploaded") published.push(r);
    else if (r.status === "rejected" || r.status === "abandoned") rejected.push(r);
    else other.push(r);
  }
  return { published, rejected, other };
}

function closestToBar(rejected: Row[], bar: number, n = 8): Row[] {
  return [...rejected].sort((a, b) => Math.abs(num(a.overall) - bar) - Math.abs(num(b.overall) - bar)).slice(0, n);
}

function subNicheRejectRate(rows: Row[]): { niche: string; total: number; rejected: number; rate: number }[] {
  const byNiche = new Map<string, { total: number; rejected: number }>();
  for (const r of rows) {
    const cur = byNiche.get(r.sub_niche) ?? { total: 0, rejected: 0 };
    cur.total++;
    if (r.status === "rejected" || r.status === "abandoned") cur.rejected++;
    byNiche.set(r.sub_niche, cur);
  }
  return [...byNiche.entries()]
    .map(([niche, { total, rejected }]) => ({ niche, total, rejected, rate: rejected / total }))
    .filter((x) => x.total >= 2)
    .sort((a, b) => b.rate - a.rate);
}

async function main() {
  const cfg = loadChannel();
  const rows = await pullReviews(WINDOW_DAYS);
  const prevRows = await pullReviews(WINDOW_DAYS * 2).then((all) => all.filter((r) => new Date(r.updated_at) < new Date(Date.now() - WINDOW_DAYS * 86400_000)));

  const { published, rejected, other } = cohortSplit(rows);
  const bar = cfg.approval.minScore;

  const out: string[] = [];
  out.push(`# Scores Dashboard — last ${WINDOW_DAYS} days`);
  out.push(`\nchannel: **${cfg.channelName}**  ·  publish bar: **${bar}/10**  ·  reviews with scores: **${rows.length}**  ·  published: **${published.length}**  ·  rejected: **${rejected.length}**  ·  other: **${other.length}**`);

  out.push(section("Dimension averages (all cohorts combined)"));
  out.push("  dimension      " + " ".repeat(21) + " score    Δ vs prior " + WINDOW_DAYS + "d");
  out.push(dimAverages(rows, prevRows));

  if (published.length) {
    out.push(section(`Dimension averages — published cohort (${published.length})`));
    out.push(dimAverages(published));
  }

  if (rejected.length) {
    out.push(section(`Dimension averages — rejected cohort (${rejected.length})`));
    out.push(dimAverages(rejected));

    out.push(section("Rejected scripts closest to the publish bar"));
    out.push("These are the scripts you came *this close* to shipping — the ones to study.\n");
    out.push("  overall  gap   sub_niche                   title");
    for (const r of closestToBar(rejected, bar)) {
      const o = num(r.overall);
      const gap = (bar - o).toFixed(1);
      out.push(`   ${fmt(o)}    ${String(gap).padStart(4)}   ${r.sub_niche.padEnd(26)}  ${(r.title ?? "(no title)").slice(0, 60)}`);
    }

    out.push(section("Sub-niche reject rate (≥ 2 attempts)"));
    out.push("  rate   rejected / total  sub_niche");
    for (const { niche, total, rejected: rj, rate } of subNicheRejectRate(rows)) {
      out.push(`  ${(rate * 100).toFixed(0).padStart(3)}%    ${String(rj).padStart(2)} / ${String(total).padStart(2)}        ${niche}`);
    }
  }

  if (!rows.length) {
    out.push(section("Diagnostic — why 0 rows?"));
    out.push("Running the dashboard query piece-by-piece so you can see which filter dropped them:\n");
    const diag = await diagnose(WINDOW_DAYS);
    for (const d of diag) out.push(`  ${d.n.padStart(5)}  ${d.stage}`);
    out.push("\nIf `with assets.review.scores` is 0 but `with assets.review` is > 0, the review payload");
    out.push("is missing a `scores` object — probably persisted via a path that doesn't set it (bug upstream).");
    out.push("If `with scores AND updated in window` is 0 but `with assets.review.scores` is > 0, bump WINDOW_DAYS.");
    out.push("If `total videos` is 0, you're pointing at the wrong database — check DATABASE_URL in .env.");
  }

  console.log(out.join("\n"));
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
