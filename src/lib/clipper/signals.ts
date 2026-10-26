/**
 * Clipper M5 — audience-retention signals extracted from PUBLIC data only (we can't see other
 * channels' Analytics). Three sources combined into one engagement curve per video:
 *
 *   1. Heatmap        → YouTube's own "Most Replayed" curve (yt-dlp heatmap field, when exposed).
 *                       Strongest signal when present; not every video has it.
 *   2. Comments       → Timestamps mentioned in top comments ("@6:35 THIS").  Crowdsourced proxy.
 *                       Weaker but almost always available on popular videos.
 *   3. Chapters       → Creator-marked segment boundaries. Noisy "engagement" signal but a free
 *                       hint at where coherent segments live.
 *
 * Output: an engagement curve sampled at 1-second resolution, 0-1 normalized, plus a list of
 * "peaks" (contiguous spans above a threshold). Peaks become candidate clip windows.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ytdlpCommon } from "./ytdlp-args.js";

const exec = promisify(execFile);

export type HeatmapEntry = { start_time: number; end_time: number; value: number };
export type TimestampCluster = { atSec: number; mentions: number; sampleComments: string[] };
export type SignalCurve = { durationSec: number; samples: number[]; sources: string[] };
export type Peak = { startSec: number; endSec: number; strength: number; sources: string[] };

/** Pull heatmap + chapters + top comments in ONE yt-dlp -J call. Cheap, authenticated via the
 *  same cookies-from-browser as other calls. */
export async function fetchAudienceData(url: string, maxComments = 500): Promise<{
  durationSec: number;
  heatmap: HeatmapEntry[] | null;
  chapters: Array<{ title: string; startSec: number; endSec: number }>;
  comments: Array<{ text: string; likes: number }>;
}> {
  const { stdout } = await exec("yt-dlp", [
    ...ytdlpCommon(),
    "-J", "--no-warnings", "--skip-download",
    "--write-comments",
    "--extractor-args", `youtube:comment_sort=top;max_comments=${maxComments},all,all,100`,
    url,
  ], { maxBuffer: 128 * 1024 * 1024 });
  const info = JSON.parse(stdout) as {
    duration?: number;
    heatmap?: HeatmapEntry[];
    chapters?: Array<{ title: string; start_time: number; end_time: number }>;
    comments?: Array<{ text: string; like_count?: number }>;
  };
  return {
    durationSec: Math.round(info.duration ?? 0),
    heatmap: info.heatmap ?? null,
    chapters: (info.chapters ?? []).map((c) => ({ title: c.title, startSec: c.start_time, endSec: c.end_time })),
    comments: (info.comments ?? []).map((c) => ({ text: c.text, likes: c.like_count ?? 0 })),
  };
}

/** Scan a comment list for mm:ss or hh:mm:ss patterns, cluster within ±15s windows. Weight by
 *  comment like count so a single whale-liked timestamp beats a noisy spam cluster. */
export function clusterTimestamps(comments: Array<{ text: string; likes: number }>, durationSec: number): TimestampCluster[] {
  const TS_RE = /\b(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\b/g;
  const WEIGHT_CAP = 50; // one comment with 10k likes shouldn't drown everything else
  const points: Array<{ atSec: number; weight: number; text: string }> = [];
  for (const c of comments) {
    const seen = new Set<number>(); // dedupe within one comment
    const weight = Math.min(1 + Math.log10(1 + c.likes), WEIGHT_CAP);
    let m: RegExpExecArray | null;
    while ((m = TS_RE.exec(c.text))) {
      const h = m[1] ? Number(m[1]) : 0;
      const atSec = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (atSec <= 0 || atSec >= durationSec || seen.has(atSec)) continue;
      seen.add(atSec);
      points.push({ atSec, weight, text: c.text.slice(0, 100) });
    }
  }
  points.sort((a, b) => a.atSec - b.atSec);

  const clusters: TimestampCluster[] = [];
  const WIN_SEC = 15;
  for (const p of points) {
    const last = clusters[clusters.length - 1];
    if (last && p.atSec - last.atSec <= WIN_SEC) {
      last.mentions += p.weight;
      if (last.sampleComments.length < 3) last.sampleComments.push(p.text);
    } else {
      clusters.push({ atSec: p.atSec, mentions: p.weight, sampleComments: [p.text] });
    }
  }
  return clusters.sort((a, b) => b.mentions - a.mentions);
}

/** Combine heatmap, comment clusters, chapter starts into one 1-Hz curve 0..1. Each source is
 *  normalized to its own max, then weighted (heatmap most). */
export function buildCurve(
  durationSec: number,
  heatmap: HeatmapEntry[] | null,
  clusters: TimestampCluster[],
  chapters: Array<{ startSec: number; endSec: number }>,
): SignalCurve {
  const N = Math.max(1, Math.round(durationSec));
  const samples = new Float32Array(N);
  const sources: string[] = [];

  if (heatmap && heatmap.length) {
    sources.push("heatmap");
    const maxH = heatmap.reduce((m, h) => Math.max(m, h.value), 0) || 1;
    for (const h of heatmap) {
      const a = Math.max(0, Math.floor(h.start_time));
      const b = Math.min(N, Math.ceil(h.end_time));
      const v = (h.value / maxH) * 1.0; // weight 1.0
      for (let i = a; i < b; i++) samples[i] = (samples[i] ?? 0) + v;
    }
  }

  if (clusters.length) {
    sources.push("comments");
    const maxC = clusters.reduce((m, c) => Math.max(m, c.mentions), 0) || 1;
    for (const c of clusters) {
      const a = Math.max(0, c.atSec - 10);
      const b = Math.min(N, c.atSec + 20); // asymmetric: comment timestamp usually marks the START of the moment
      const v = (c.mentions / maxC) * 0.7; // weight 0.7
      for (let i = a; i < b; i++) samples[i] = (samples[i] ?? 0) + v;
    }
  }

  if (chapters.length) {
    sources.push("chapters");
    // Small bump at each chapter START to break ties when two peaks are equal
    for (const ch of chapters) {
      const a = Math.max(0, ch.startSec);
      const b = Math.min(N, ch.startSec + 30);
      for (let i = a; i < b; i++) samples[i] = (samples[i] ?? 0) + 0.1;
    }
  }

  // Normalize final curve to 0..1.
  const max = Array.from(samples).reduce((m, v) => Math.max(m, v), 0) || 1;
  return { durationSec, samples: Array.from(samples).map((v) => v / max), sources };
}

/** Find peaks in the engagement curve: contiguous spans at or above `minStrength`, length within
 *  the band. Returns most-engaging first. Peaks are extended out to the band's lower bound using
 *  the strongest neighborhood when a raw cluster is too short. */
export function extractPeaks(
  curve: SignalCurve,
  minLengthSec: number,
  maxLengthSec: number,
  minStrength = 0.35,
): Peak[] {
  const s = curve.samples;
  const N = s.length;
  const raw: Peak[] = [];

  // Pass 1: find contiguous above-threshold spans
  let i = 0;
  while (i < N) {
    if ((s[i] ?? 0) < minStrength) { i++; continue; }
    let j = i;
    let strength = 0;
    while (j < N && (s[j] ?? 0) >= minStrength) { strength += s[j] ?? 0; j++; }
    const dur = j - i;
    raw.push({ startSec: i, endSec: j, strength: strength / Math.max(1, dur), sources: curve.sources });
    i = j;
  }

  // Pass 2: expand too-short peaks around their center within the max band
  const expanded = raw.map((p) => {
    const dur = p.endSec - p.startSec;
    if (dur >= minLengthSec) return p;
    const center = (p.startSec + p.endSec) / 2;
    const half = minLengthSec / 2;
    const startSec = Math.max(0, Math.floor(center - half));
    const endSec = Math.min(N, Math.ceil(center + half));
    return { ...p, startSec, endSec };
  });

  // Pass 3: trim too-long peaks to maxLengthSec around their strongest center
  const trimmed = expanded.map((p) => {
    const dur = p.endSec - p.startSec;
    if (dur <= maxLengthSec) return p;
    // Find strongest ~maxLengthSec window inside this peak
    let best = { start: p.startSec, strength: -1 };
    for (let a = p.startSec; a <= p.endSec - maxLengthSec; a++) {
      let strength = 0;
      for (let k = a; k < a + maxLengthSec; k++) strength += s[k] ?? 0;
      if (strength > best.strength) best = { start: a, strength };
    }
    return { ...p, startSec: best.start, endSec: best.start + maxLengthSec };
  });

  return trimmed.sort((a, b) => b.strength - a.strength);
}

/** Convenience: pull everything + extract peaks in one call. */
export async function retentionPeaks(url: string, minLengthSec: number, maxLengthSec: number): Promise<{
  durationSec: number;
  peaks: Peak[];
  curve: SignalCurve;
}> {
  const d = await fetchAudienceData(url);
  const clusters = clusterTimestamps(d.comments, d.durationSec);
  const curve = buildCurve(d.durationSec, d.heatmap, clusters, d.chapters);
  const peaks = extractPeaks(curve, minLengthSec, maxLengthSec);
  return { durationSec: d.durationSec, peaks, curve };
}
