/**
 * Clip discovery library. Given a long YouTube URL, download the video's metadata and auto-captions
 * via yt-dlp, parse the captions into timed segments, and ask the LLM to pick 20–55s spans that
 * survive on their own. Criteria are a near-verbatim port of the youtube-agent-skill `yt-shorts`
 * SKILL.md (MIT, Jake Schincariol, 2026):
 *
 *   1. Opens on a complete thought. If the first sentence needs the previous minute, it's not a Short.
 *   2. There is a turn in it — a claim, then something that complicates or proves it.
 *   3. Ends on a line, not a trail-off.
 *
 * The LLM output includes a NEW first line (rewritten hook), on-screen text for the first two
 * seconds, a loop-point hint, and a vertical-framing note — same shape as the skill's spec.
 *
 * NOTE: Downloading videos you did not create risks copyright infringement and ToS violations.
 * The user has accepted that legal responsibility for this project. We never download the actual
 * video stream at this stage — only captions + metadata, which are much lighter and faster to
 * iterate on. Clip extraction (actually cutting the video) happens in a later milestone.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { askJson } from "./llm.js";
import { ytdlpCommon } from "./clipper/ytdlp-args.js";

const exec = promisify(execFile);

export type CaptionCue = { startSec: number; endSec: number; text: string };

export type VideoMeta = {
  id: string;
  title: string;
  uploader: string;
  durationSec: number;
  viewCount?: number;
  chapters?: Array<{ title: string; startSec: number; endSec: number }>;
};

// Hard clip-window constraints. The LLM has been known to return 1-second windows when the prompt
// wasn't explicit enough — these bounds back the schema up so broken picks fail validation.
export const CLIP_MIN_SEC = 20;
export const CLIP_MAX_SEC = 90;

export const ClipCandidate = z.object({
  rank: z.number().int().min(1),
  startSec: z.number().min(0).describe("Start time in SECONDS from the beginning of the source video"),
  endSec: z.number().min(0).describe("End time in SECONDS; MUST be at least 20 and at most 90 seconds AFTER startSec"),
  originalFirstLine: z.string(),
  newFirstLine: z.string().describe("A rewritten hook that works without the surrounding video context"),
  onScreenText: z.string().describe("Different words from the spoken line; shown for the first two seconds"),
  loopPoint: z.string().describe("What the last line sets up so the first line answers it"),
  framingNote: z.string().describe("What gets cropped out of a 16:9 frame for 9:16 vertical and whether it matters"),
  rationale: z.string().describe("Why this span survives on its own — reference the three gates (complete opening / a turn / lands on a line)"),
}).refine((c) => (c.endSec - c.startSec) >= CLIP_MIN_SEC && (c.endSec - c.startSec) <= CLIP_MAX_SEC, {
  message: `clip duration (endSec - startSec) must be between ${CLIP_MIN_SEC}s and ${CLIP_MAX_SEC}s`,
});
export type ClipCandidate = z.infer<typeof ClipCandidate>;

export const ClipList = z.object({
  candidates: z.array(ClipCandidate).min(1).max(5),
});
export type ClipList = z.infer<typeof ClipList>;

/** Fetch video metadata as JSON via yt-dlp. Public-page only, no auth. */
export async function fetchMeta(url: string): Promise<VideoMeta> {
  const { stdout } = await exec("yt-dlp", [...ytdlpCommon(), "-J", "--no-warnings", "--skip-download", url], { maxBuffer: 32 * 1024 * 1024 });
  const info = JSON.parse(stdout) as {
    id: string; title: string; uploader?: string; channel?: string; duration?: number;
    view_count?: number; chapters?: Array<{ title: string; start_time: number; end_time: number }>;
  };
  return {
    id: info.id,
    title: info.title,
    uploader: info.uploader ?? info.channel ?? "unknown",
    durationSec: Math.round(info.duration ?? 0),
    viewCount: info.view_count,
    chapters: info.chapters?.map((c) => ({ title: c.title, startSec: c.start_time, endSec: c.end_time })),
  };
}

/** Download auto-captions (English preferred) into a temp dir and parse to cues. Throws a clear
 *  error if no captions exist — Whisper-based transcription is a later milestone.
 *
 *  YouTube's caption endpoint rate-limits aggressively (HTTP 429) when a URL is popular. We retry
 *  with exponential backoff — 5s, 15s, 45s — before giving up. Metadata endpoint has a different
 *  limit profile, so one failure here doesn't force a full re-fetch of meta. */
export async function fetchCaptions(url: string, lang = "en"): Promise<CaptionCue[]> {
  const tmp = path.join(tmpdir(), `yt-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(tmp, { recursive: true });
  const delays = [5000, 15000, 45000];
  try {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await exec("yt-dlp", [
          ...ytdlpCommon(),
          "--write-auto-sub", "--write-sub",
          "--sub-lang", lang,
          "--sub-format", "vtt",
          "--skip-download",
          "-o", path.join(tmp, "%(id)s.%(ext)s"),
          url,
        ], { maxBuffer: 32 * 1024 * 1024 });
        break;
      } catch (e) {
        const msg = (e as Error).message;
        const is429 = /HTTP Error 429|Too Many Requests/i.test(msg);
        if (!is429 || attempt === delays.length) throw e;
        const wait = delays[attempt]!;
        console.warn(`[clip] YouTube rate-limited caption fetch (429). Retry ${attempt + 1}/${delays.length} in ${wait / 1000}s…`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tmp);
    const vtt = files.find((f) => f.endsWith(".vtt"));
    if (!vtt) {
      throw new Error(`no captions available for this video in '${lang}'. Try a different language, or add Whisper transcription (future milestone).`);
    }
    return parseVtt(await readFile(path.join(tmp, vtt), "utf8"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Parse a .vtt subtitle file into timed cues. Handles the common auto-caption rolling-text
 *  format where each cue duplicates the previous line; we dedupe adjacent-identical lines. */
export function parseVtt(vtt: string): CaptionCue[] {
  const blocks = vtt.replace(/^WEBVTT.*?\n\n/s, "").split(/\n\n+/);
  const cues: CaptionCue[] = [];
  const tsRe = /(\d\d:\d\d:\d\d\.\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d\.\d\d\d)/;
  const toSec = (ts: string) => {
    const [h, m, s] = ts.split(":"); return (+h) * 3600 + (+m!) * 60 + parseFloat(s!);
  };
  let lastText = "";
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const tsLine = lines.find((l) => tsRe.test(l));
    if (!tsLine) continue;
    const m = tsRe.exec(tsLine)!;
    const text = lines.slice(lines.indexOf(tsLine) + 1)
      .join(" ")
      // Strip inline timestamp tags like <00:00:01.080>
      .replace(/<\d\d:\d\d:\d\d\.\d\d\d>/g, "")
      // Strip speaker/style tags
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === lastText) continue;
    cues.push({ startSec: toSec(m[1]!), endSec: toSec(m[2]!), text });
    lastText = text;
  }
  return cues;
}

/** Collapse rolling-text cues into a readable transcript annotated with [MM:SS] every ~15 seconds.
 *  Small, LLM-friendly, preserves timecodes without blowing up tokens. */
export function transcriptForLlm(cues: CaptionCue[]): string {
  const lines: string[] = [];
  let nextStamp = 0;
  for (const c of cues) {
    if (c.startSec >= nextStamp) {
      const mm = String(Math.floor(c.startSec / 60)).padStart(2, "0");
      const ss = String(Math.floor(c.startSec % 60)).padStart(2, "0");
      lines.push(`[${mm}:${ss}]`);
      nextStamp = c.startSec + 15;
    }
    lines.push(c.text);
  }
  return lines.join(" ");
}

const SYSTEM = `You are the yt-shorts skill from Jake Schincariol's youtube-agent-skill (MIT). Your job: read a long-video transcript and pick 3-5 spans of 20-90 SECONDS that survive on their own as a Short.

HARD CONSTRAINTS (your output will be rejected if violated):
- Each candidate's (endSec - startSec) MUST be between 20 and 90 seconds. A 1-second window is NOT a clip. A 10-second window is NOT a clip. Think "a good standalone moment of 30-60s" is typical.
- startSec and endSec are measured in SECONDS from the beginning of the source video, taken from the [MM:SS] markers in the transcript (NOT from the transcript's word position).
- Timestamps must land on actual spoken content from the transcript, not on silence or music.

The three gates (ALL must be true for each candidate):
1. Opens on a complete thought. If the first sentence needs the previous minute, it is NOT a Short.
2. There is a turn in it — a claim, then something that complicates it or proves it.
3. Ends on a line, not a trail-off.

For each candidate also deliver:
- A NEW first line that works without the long-video context (the old first line usually assumes context).
- On-screen text for the first two seconds (different words from the spoken line).
- A loop-point hint: what the last line sets up so the first line answers it (so the Short loops back cleanly).
- A vertical framing note: what gets cropped from a 16:9 frame when going 9:16, and whether it matters.
- Rationale citing which gate(s) the span passes and how.

Prefer density over quantity. 3 strong candidates > 5 weak ones. Rank 1 is the best.`;

/** Ask the LLM to pick top-N candidates from a transcript. Uses the project's shared `askJson`
 *  so routing, retries, and provider fallback are consistent with the rest of the pipeline. */
export async function pickCandidates(meta: VideoMeta, cues: CaptionCue[]): Promise<ClipList> {
  const transcript = transcriptForLlm(cues);
  const prompt = [
    `VIDEO: ${meta.title}`,
    `BY: ${meta.uploader}`,
    `DURATION: ${meta.durationSec} seconds total (${Math.floor(meta.durationSec / 60)}m${meta.durationSec % 60}s)`,
    `MAX endSec: ${meta.durationSec} — DO NOT pick a timestamp beyond this. The last valid clip is roughly startSec=${Math.max(0, meta.durationSec - 90)}, endSec=${meta.durationSec}.`,
    meta.chapters?.length ? `CHAPTERS:\n${meta.chapters.map((c) => `  [${Math.floor(c.startSec / 60)}:${String(Math.floor(c.startSec % 60)).padStart(2, "0")}] ${c.title}`).join("\n")}` : "",
    "",
    "TRANSCRIPT (auto-captioned, [MM:SS] markers every ~15 seconds):",
    transcript,
    "",
    `Pick 3-5 clip candidates. Return JSON matching the schema. startSec and endSec are the actual spans you'd cut from the source video, in SECONDS, with 0 ≤ startSec < endSec ≤ ${meta.durationSec}.`,
  ].filter(Boolean).join("\n");

  const raw = await askJson<ClipList>({
    tier: "heavy",
    // "write" is this project's long-form content role — routes to whichever provider
    // LLM_ROLE_WRITE names (Mistral by default), falls back to LLM_PROVIDER otherwise.
    // Picks text-only providers; a clip pick never needs vision.
    role: "write",
    system: SYSTEM,
    prompt,
    schema: ClipList,
    maxTokens: 8000,
  });

  // Defensive post-filter: duration band AND video-duration bounds. Log what we dropped so a
  // future reader sees why N candidates became N-k. If nothing survives, let the caller fail.
  const kept = raw.candidates.filter((c) => {
    const dur = c.endSec - c.startSec;
    if (dur < CLIP_MIN_SEC || dur > CLIP_MAX_SEC) {
      console.warn(`[pick] dropping rank ${c.rank}: duration ${dur.toFixed(1)}s out of band [${CLIP_MIN_SEC}, ${CLIP_MAX_SEC}]`);
      return false;
    }
    if (c.endSec > meta.durationSec) {
      console.warn(`[pick] dropping rank ${c.rank}: endSec ${c.endSec}s > source duration ${meta.durationSec}s`);
      return false;
    }
    if (c.startSec < 0) {
      console.warn(`[pick] dropping rank ${c.rank}: startSec ${c.startSec}s < 0`);
      return false;
    }
    return true;
  });
  if (!kept.length) throw new Error(`LLM returned ${raw.candidates.length} candidates but all were rejected. Rerun or adjust the prompt.`);
  return { candidates: kept };
}

/** Format a candidate list for a readable terminal report. */
export function formatCandidates(meta: VideoMeta, list: ClipList): string {
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const lines: string[] = [
    `\n╔ ${meta.title}`,
    `║ by ${meta.uploader} — ${fmt(meta.durationSec)}${meta.viewCount ? ` — ${meta.viewCount.toLocaleString()} views` : ""}`,
    `╚ ${list.candidates.length} candidate clips`,
    "",
  ];
  for (const c of list.candidates) {
    const dur = c.endSec - c.startSec;
    lines.push(`#${c.rank}  [${fmt(c.startSec)}–${fmt(c.endSec)}]  ${dur.toFixed(0)}s`);
    lines.push(`     original  "${c.originalFirstLine}"`);
    lines.push(`     NEW hook  "${c.newFirstLine}"`);
    lines.push(`     on-screen "${c.onScreenText}"`);
    lines.push(`     loop      ${c.loopPoint}`);
    lines.push(`     framing   ${c.framingNote}`);
    lines.push(`     rationale ${c.rationale}`);
    lines.push("");
  }
  return lines.join("\n");
}
