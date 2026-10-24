/**
 * Clipper M4 — outcomes. Records every clip the pipeline PRODUCES or REJECTS alongside WHY, plus
 * (eventually, when the user ships one) its real YouTube performance 7 days later. Over time this
 * builds a dataset that the ranker can be re-trained against.
 *
 * Honest reality check: a "learning loop" needs DATA. You have ~1 clip now. For the first ~20-50
 * clips this module just RECORDS. After ~50 shipped clips with outcomes, we can start fitting
 * the signals in src/lib/clipper/discover.ts to actual YouTube performance (CTR / 24h-views /
 * retention). Until then it's scaffolding, not AI.
 *
 * Three write surfaces:
 *   1. recordProduced(entry): called by the pipeline when a clip reaches the pending folder.
 *      Stores source signals, scoring breakdown, decision rationale.
 *   2. recordRejected(entry): called when a clip FAILED the gates and was DROPPED (never shipped).
 *      Stores what gates failed and why — the "what failed" learning the user asked for.
 *   3. recordPublished(entry): called when the user approves + uploads (or when the YT upload
 *      flow in a later milestone marks it uploaded). Stores the uploaded YT video id.
 *
 * Read surface: analyze() walks outcomes.json and emits aggregate stats (which signals correlate
 * with pass/fail/success). Useful once you have real data; harmless on empty data.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTCOMES_FILE = path.join(ROOT, "data", "clipper", "outcomes.json");

export type OutcomeKind = "produced" | "rejected" | "published" | "underperformed";

export type OutcomeRecord = {
  /** The source YouTube video id (not the clip's output filename). */
  sourceVideoId: string;
  /** For produced clips: the file path. For rejected: null. */
  clipPath?: string;
  /** When this outcome was recorded. */
  recordedAt: string;
  kind: OutcomeKind;
  /** Rich context — ranker signals, scoring gates, decision rationale, reject reason, etc. */
  context: {
    sourceTitle?: string;
    sourceChannel?: string;
    sourceViewCount?: number;
    rankerSignals?: Record<string, number>;
    rankerScore?: number;
    clipScore?: number;
    gatesPassed?: string[];
    gatesFailed?: string[];
    criticalFails?: string[];
    decisionFormat?: "shorts" | "long";
    decisionRationale?: string;
    rejectReason?: string;             // why we dropped it (gates failed + which)
    rejectDetails?: Record<string, unknown>;
    /** Set when kind=published */
    youtubeUploadId?: string;
    /** Set by a future performance-poll job (24h or 7d after upload). */
    youtube24hViews?: number;
    youtube7dViews?: number;
    youtube7dCtr?: number;
    youtube7dAvgViewDurationSec?: number;
    /** Set when kind=underperformed by the retro job. */
    expected?: number;
    observed?: number;
  };
};

type OutcomesFile = {
  version: 1;
  records: OutcomeRecord[];
};

async function load(): Promise<OutcomesFile> {
  if (!existsSync(OUTCOMES_FILE)) return { version: 1, records: [] };
  try {
    const parsed = JSON.parse(await readFile(OUTCOMES_FILE, "utf8")) as OutcomesFile;
    if (parsed.version !== 1) throw new Error(`unknown outcomes version ${parsed.version}`);
    return parsed;
  } catch (e) {
    console.warn(`[outcomes] load failed: ${(e as Error).message}. starting fresh.`);
    return { version: 1, records: [] };
  }
}

async function save(f: OutcomesFile): Promise<void> {
  await mkdir(path.dirname(OUTCOMES_FILE), { recursive: true });
  // Sort newest-first so the file reads like a timeline.
  const sorted: OutcomesFile = { version: 1, records: [...f.records].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)) };
  await writeFile(OUTCOMES_FILE, JSON.stringify(sorted, null, 2) + "\n");
}

export async function record(entry: Omit<OutcomeRecord, "recordedAt">): Promise<void> {
  const f = await load();
  f.records.push({ ...entry, recordedAt: new Date().toISOString() });
  await save(f);
}

export const recordProduced = (sourceVideoId: string, clipPath: string, context: OutcomeRecord["context"]) =>
  record({ sourceVideoId, clipPath, kind: "produced", context });

export const recordRejected = (sourceVideoId: string, context: OutcomeRecord["context"]) =>
  record({ sourceVideoId, kind: "rejected", context });

export const recordPublished = (sourceVideoId: string, youtubeUploadId: string, context: OutcomeRecord["context"] = {}) =>
  record({ sourceVideoId, kind: "published", context: { ...context, youtubeUploadId } });

/** Aggregate stats across every recorded outcome. Called by `npm run clip:analyze`. */
export async function analyze(): Promise<{
  total: number;
  byKind: Record<OutcomeKind, number>;
  gateFailFrequency: Record<string, number>;
  averageProducedScore: number;
  averageRejectedScore: number;
  topRejectReasons: Array<{ reason: string; count: number }>;
  signalCorrelations: {
    note: string;
    bestSignalForPassing: string | null;
  };
}> {
  const f = await load();
  const total = f.records.length;
  const byKind: Record<OutcomeKind, number> = { produced: 0, rejected: 0, published: 0, underperformed: 0 };
  const gateFailFreq: Record<string, number> = {};
  const rejectReasonCount: Record<string, number> = {};
  let producedScoreSum = 0, producedScoreN = 0;
  let rejectedScoreSum = 0, rejectedScoreN = 0;
  const signalPassSum: Record<string, number> = {};
  const signalPassN: Record<string, number> = {};
  const signalFailSum: Record<string, number> = {};
  const signalFailN: Record<string, number> = {};

  for (const r of f.records) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    for (const g of (r.context.gatesFailed ?? [])) gateFailFreq[g] = (gateFailFreq[g] ?? 0) + 1;
    if (r.context.rejectReason) rejectReasonCount[r.context.rejectReason] = (rejectReasonCount[r.context.rejectReason] ?? 0) + 1;
    if (r.kind === "produced" || r.kind === "published") {
      if (typeof r.context.clipScore === "number") { producedScoreSum += r.context.clipScore; producedScoreN++; }
      for (const [k, v] of Object.entries(r.context.rankerSignals ?? {})) {
        signalPassSum[k] = (signalPassSum[k] ?? 0) + v; signalPassN[k] = (signalPassN[k] ?? 0) + 1;
      }
    } else if (r.kind === "rejected") {
      if (typeof r.context.clipScore === "number") { rejectedScoreSum += r.context.clipScore; rejectedScoreN++; }
      for (const [k, v] of Object.entries(r.context.rankerSignals ?? {})) {
        signalFailSum[k] = (signalFailSum[k] ?? 0) + v; signalFailN[k] = (signalFailN[k] ?? 0) + 1;
      }
    }
  }

  // Which signal most separates passers from rejectees? Largest (pass_avg - fail_avg) / fail_avg.
  let bestSignal: string | null = null;
  let bestSep = 0;
  for (const k of Object.keys(signalPassSum)) {
    const passAvg = signalPassSum[k]! / Math.max(1, signalPassN[k] ?? 1);
    const failAvg = (signalFailSum[k] ?? 0) / Math.max(1, signalFailN[k] ?? 1);
    const sep = failAvg !== 0 ? Math.abs((passAvg - failAvg) / failAvg) : Math.abs(passAvg);
    if (sep > bestSep) { bestSep = sep; bestSignal = k; }
  }

  return {
    total,
    byKind,
    gateFailFrequency: gateFailFreq,
    averageProducedScore: producedScoreN ? producedScoreSum / producedScoreN : 0,
    averageRejectedScore: rejectedScoreN ? rejectedScoreSum / rejectedScoreN : 0,
    topRejectReasons: Object.entries(rejectReasonCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
    signalCorrelations: {
      note: total < 20 ? "need >=20 outcomes before signal correlations mean anything" : `strongest separator between passed vs rejected (by % difference)`,
      bestSignalForPassing: bestSignal,
    },
  };
}
