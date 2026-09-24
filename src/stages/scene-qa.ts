/**
 * Per-scene footage selection — an editor choosing B-roll, not a judge grading one picture.
 *
 * WHAT WAS WRONG (run of 21 Sep, every scene 0-4/10):
 *  - The rubric demanded a literal depiction: "10 = exactly the thing being described; merely not
 *    wrong is a 5". Stock cannot show THIS cable whipping at THIS moment, so the best honest stock
 *    shot scored 4-5 and the 7.5 bar was unreachable whatever the search returned.
 *  - Each search returned 30-40 results; one was kept (ranked by caption word-overlap, which bug #5
 *    already showed is meaningless) and judged alone. Retries were further blind single picks.
 *
 * WHAT THIS DOES:
 *  - Gathers up to 9 candidates per scene from several searches (thumbnails only — cheap).
 *  - Lays them out as a numbered contact sheet and asks ONE vision call to pick the best three,
 *    scored on the question a documentary editor actually asks: would I cut this under this line?
 *  - Only if nothing clears the bar, a second sheet from the editor's own suggested searches.
 *  - Downloads full resolution for the chosen shots only, and uses the top three as the scene's cuts,
 *    so every shot in the scene was chosen rather than just the first.
 *
 * At most two vision calls per scene, each seeing nine options — against up to three calls each
 * seeing one. More chances, fewer calls.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChannelConfig } from "../config";
import { downloadCandidate, fetchThumb, gatherCandidates, type Candidate } from "../lib/candidates";
import { askJson, isQuota, providerSupportsVision, QuotaError } from "../lib/llm";
import { incident, log } from "../lib/log";
import { sh } from "../lib/media";
import type { ImageCredit } from "./visuals";

export const SCENE_BAR = Number(process.env.SCENE_BAR ?? 7.5);
/** A second or third cut in a scene may be a little weaker than its lead shot, but not unrelated. */
const SUPPORT_BAR = Number(process.env.SCENE_SUPPORT_BAR ?? 6);
const SHEET_SIZE = 9;
/**
 * Vision calls this stage may spend per run. The final check also needs vision, so selection must
 * never be able to use up the quota the last gate depends on.
 */
const VISION_BUDGET = Number(process.env.SCENE_VISION_BUDGET ?? 36);
let visionSpent = 0;
let visionExhausted = false;
export const resetSelectionBudget = () => { visionSpent = 0; visionExhausted = false; };

const Pick = z.object({
  ranking: z.array(z.object({
    n: z.coerce.number().int().min(1),
    score: z.coerce.number().min(0).max(10),
    why: z.string(),
  })).min(1).max(3),
  // Only needed when nothing clears the bar; models sometimes send a string or omit it.
  suggestQueries: z.preprocess((x) => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []), z.array(z.string())).default([]),
});

type Scene = { id: string; narration: string; imageQuery: string; altQueries?: string[]; era?: string; motion?: string };

const FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"];
async function font(): Promise<string | null> {
  for (const f of FONTS) if (await fs.access(f).then(() => true, () => false)) return f;
  return null;
}

/** Numbered 3x3 grid of thumbnails. Returns the sheet and which candidate sits at each number. */
async function contactSheet(cands: Candidate[], dir: string, tag: string, portrait = false): Promise<{ sheet: string; order: Candidate[] } | null> {
  const [tw, th] = portrait ? [216, 384] : [384, 216];
  const work = path.join(dir, `sheet-${tag}`);
  await fs.mkdir(work, { recursive: true });
  const f = await font();
  const order: Candidate[] = [];
  for (const c of cands) {
    const raw = path.join(work, `raw-${order.length + 1}.jpg`);
    if (!(await fetchThumb(c, raw))) continue;
    const n = order.length + 1;
    const tile = path.join(work, `tile-${String(n).padStart(2, "0")}.jpg`);
    const label = f ? `,drawtext=fontfile='${f}':text='${n}${c.kind === "video" ? " ▶" : ""}':x=10:y=8:fontsize=40:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=8` : "";
    const ok = await sh("ffmpeg", ["-y", "-v", "error", "-i", raw, "-vf",
      // Crop to the frame the viewer will actually see, so the editor judges that and not the original.
      `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th}${label}`,
      "-frames:v", "1", tile]).then(() => true, () => false);
    // A clean exit does not prove a file was written (that is what caused the ENOENT in the 21 Sep
    // run), so check the file itself.
    if (ok && (await fs.stat(tile).then((s) => s.size > 500, () => false))) order.push(c);
    if (order.length >= SHEET_SIZE) break;
  }
  if (!order.length) return null;
  const sheet = path.join(dir, `sheet-${tag}.jpg`);
  const ok = await sh("ffmpeg", ["-y", "-v", "error", "-framerate", "1", "-i", path.join(work, "tile-%02d.jpg"),
    "-vf", "tile=3x3:padding=6:color=0x202020", "-frames:v", "1", sheet]).then(() => true, () => false);
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  if (!ok || !(await fs.stat(sheet).then((s) => s.size > 1000, () => false))) return null;
  return { sheet, order };
}

const EDITOR = `You are a documentary editor choosing B-ROLL from stock footage.

You are shown a numbered contact sheet (▶ marks a video clip) and ONE line of narration. Stock footage
never shows the exact historical moment; nobody expects it to. Your question is the one every editor
asks: would I cut this shot under this line, and would it hold the viewer's attention there?

Score each shot you rank:
 9-10  shows the actual subject, place or process the line describes
 7-8   strong B-roll: clearly the right subject, material, setting or kind of action — a viewer
       feels it belongs, even though it is not that specific event
 5-6   loosely related or generic; it fills the screen but adds nothing
 0-4   wrong subject; wrong era (modern tech, cars or clothing in a period story); a recognisable
       person as the subject; text, logos, watermarks, charts or diagrams; clip-art or illustration

Prefer a moving clip (▶) over a still when the line describes motion or process.
Rank your best THREE, best first. If none reaches 7, also suggest two stock-library searches
(2-4 words, concrete and filmable) that would find better footage for this line.`;

async function choose(scene: Scene, cands: Candidate[], dir: string, videoId: number, tag: string, portrait = false) {
  if (visionExhausted || visionSpent >= VISION_BUDGET) { visionExhausted = true; return null; }
  const cs = await contactSheet(cands, dir, tag, portrait);
  if (!cs) return null;
  visionSpent++;
  const v = await askJson({
    tier: "light",
    role: "vision",
    schema: Pick,
    images: [cs.sheet],
    system: EDITOR,
    prompt: `NARRATION: ${scene.narration}\nERA: ${scene.era ?? "any"}\n` +
      `The sheet has ${cs.order.length} numbered shots. Return JSON: ` +
      `{ "ranking": [{ "n", "score", "why" }] (best 3), "suggestQueries": [2 searches, only if none reaches 7] }`,
  }).catch(async (e) => {
    // Out of vision quota: stop asking for the rest of the run. Every further call would fail the
    // same way, and each one would count a perfectly good scene as a failure.
    if (e instanceof QuotaError || isQuota(e)) visionExhausted = true;
    await incident("scene-select.error", e, videoId);
    return { error: (e as Error).message ?? String(e) } as const;
  });
  // Kept for `npm run select:test`, so a person can see exactly what the editor was shown.
  if (process.env.KEEP_SHEETS !== "true") await fs.rm(cs.sheet, { force: true }).catch(() => {});
  if ("error" in v) return v;
  // Discard numbers that are not on the sheet rather than trusting them.
  const ranked = v.ranking
    .filter((r) => r.n >= 1 && r.n <= cs.order.length)
    .map((r) => ({ c: cs.order[r.n - 1]!, score: r.score, why: r.why }));
  return { ranked, suggest: v.suggestQueries, shown: cs.order.length };
}

/** True if the scene's first file exists and is not a trivially-small placeholder. */
async function hasUsableFootage(files?: string[]): Promise<boolean> {
  const f = files?.[0];
  if (!f) return false;
  return fs.stat(f).then((st) => st.size > 1000, () => false);
}

/** When vision cannot judge a scene, take the stock libraries' own top-ranked footage. */
async function autoPickFootage(o: { dir: string; used: Set<string> }, scene: Scene, i: number,
  wantVideo: boolean, orientation: "landscape" | "portrait", credits: ImageCredit[]): Promise<string[]> {
  // allowReuse: during a vision outage a repeated on-topic shot beats an empty scene.
  const cands = await gatherCandidates([scene.imageQuery, ...(scene.altQueries ?? [])], o.used,
    { wantVideo, perQuery: 3, max: 3, orientation, allowReuse: true });
  const picked: string[] = [];
  for (const [k, c] of cands.slice(0, 3).entries()) {
    const file = path.join(o.dir, `sel-${String(i).padStart(3, "0")}-${k}.${c.kind === "video" ? "mp4" : "jpg"}`);
    if (await downloadCandidate(c, file)) {
      picked.push(file); o.used.add(c.key);
      if (k === 0) credits[i] = { source: c.source, id: c.key, title: c.caption || c.key, attribution: c.credit };
    }
  }
  return picked;
}

export async function sceneQa(o: {
  cfg: ChannelConfig;
  dir: string;
  videoId: number;
  used: Set<string>;
  scenes: Scene[];
  files: string[][];
  credits: ImageCredit[];
  fallbacks?: string[];
  attempts?: number;
  /** "portrait" for the Short: landscape stock cropped to 9:16 loses two-thirds of every frame. */
  orientation?: "landscape" | "portrait";
}): Promise<{ passed: number; failed: string[]; replaced: number; unjudged: string[]; autoPicked: string[] }> {
  const orientation = o.orientation ?? "landscape";
  const unjudged: string[] = [];
  const autoPicked: string[] = [];
  if (!providerSupportsVision()) {
    log("  scene selection skipped (provider cannot see images) — keeping the fetched footage");
    return { passed: o.scenes.length, failed: [], replaced: 0, unjudged: o.scenes.map((s) => s.id), autoPicked: [] };
  }
  const failed: string[] = [];
  let replaced = 0;

  for (const [i, scene] of o.scenes.entries()) {
    // Vision unavailable: keep what the fetch stage found. Not judging a scene is not the scene
    // failing — counting it as a failure is what would abandon an otherwise good video.
    let consecutiveErrors = 0;
    const wantVideo = scene.motion === "clip";
    if (visionExhausted || visionSpent >= VISION_BUDGET) {
      visionExhausted = true;
      // Only fetch library footage if the scene has none already: a scene that arrived with pooled
      // footage keeps it and spends nothing (that footage was chosen when the pool was built).
      if (!(await hasUsableFootage(o.files[i]))) {
        const picked = await autoPickFootage(o, scene, i, wantVideo, orientation, o.credits);
        if (picked.length) { o.files[i] = picked; autoPicked.push(scene.id); }
        log(`  scene ${scene.id}: vision budget reached, no footage yet — used the stock libraries' top ${picked.length} result(s)`);
      } else {
        log(`  scene ${scene.id}: vision budget reached — keeping its already-fetched footage (re-judged later)`);
      }
      unjudged.push(scene.id);
      continue;
    }
    let best: { c: Candidate; score: number; why: string }[] = [];
    let judgeErrors = 0;

    // Sheet 1: the scene's own searches. Sheet 2 (only if needed): the editor's suggestions plus
    // the topic's fallbacks.
    const rounds: string[][] = [[scene.imageQuery, ...(scene.altQueries ?? [])]];
    for (let r = 0; r < Math.min(2, o.attempts ?? 2) && r < rounds.length; r++) {
      let cands = await gatherCandidates(rounds[r]!, o.used, { wantVideo, perQuery: 5, max: SHEET_SIZE, orientation });
      // Vertical stock is much thinner than horizontal. Top up with landscape rather than show a
      // near-empty sheet; the render crops it, and the editor can still prefer the vertical ones.
      if (orientation === "portrait" && cands.length < 5) {
        const more = await gatherCandidates(rounds[r]!, o.used, { wantVideo, perQuery: 5, max: SHEET_SIZE - cands.length });
        cands = [...cands, ...more.filter((m) => !cands.some((c) => c.key === m.key))];
      }
      if (!cands.length) { log(`  scene ${scene.id}: no candidates for ${rounds[r]!.join(" / ")}`); continue; }
      const pick = await choose(scene, cands, o.dir, o.videoId, `${scene.id}-${r + 1}`, orientation === "portrait");
      if (pick && "error" in pick) {
        // COULD NOT JUDGE is not the same as JUDGED BAD. Treating an outage as thirteen bad scenes
        // abandoned a good script on 22 Sep (#72). Two errors in a row means vision is down: stop.
        judgeErrors++;
        if (++consecutiveErrors >= 2) visionExhausted = true;
        break;
      }
      consecutiveErrors = 0;
      if (!pick?.ranked.length) continue;
      if (!best.length || pick.ranked[0]!.score > best[0]!.score) best = pick.ranked;
      log(`  scene ${scene.id}: best of ${pick.shown} shown → ${best[0]!.score}/10 (${best[0]!.c.kind}) — ${best[0]!.why.slice(0, 70)}`);
      if (best[0]!.score >= SCENE_BAR) break;
      if (r === 0) rounds.push([...pick.suggest, ...(o.fallbacks ?? []).slice(0, 2)]);
    }

    if (!best.length && judgeErrors) {
      // Vision is down, but the video still gets made. The stock libraries already rank by relevance,
      // so their top hit for this scene's own search is a real, on-topic shot — take it and move on.
      // The video is marked so it can be re-judged later, when Gemini is back, WITHOUT re-rendering.
      if (!(await hasUsableFootage(o.files[i]))) {
        const picked = await autoPickFootage(o, scene, i, wantVideo, orientation, o.credits);
        if (picked.length) { o.files[i] = picked; autoPicked.push(scene.id); }
        log(`  scene ${scene.id}: vision unavailable, no footage yet — used the stock libraries' top ${picked.length} result(s)`);
      } else {
        log(`  scene ${scene.id}: vision unavailable — keeping its already-fetched footage (re-judged later)`);
      }
      continue;
    }

    // Download the lead and up to two supporting cuts that also clear the support bar.
    const chosen = best.filter((b, k) => k === 0 || b.score >= SUPPORT_BAR);
    const got: string[] = [];
    for (const [k, b] of chosen.entries()) {
      const file = path.join(o.dir, `sel-${String(i).padStart(3, "0")}-${k}.${b.c.kind === "video" ? "mp4" : "jpg"}`);
      if (await downloadCandidate(b.c, file)) {
        got.push(file);
        o.used.add(b.c.key);
        if (k === 0 || got.length === 1) {
          o.credits[i] = { source: b.c.source, id: b.c.key, title: b.c.caption || b.c.key, attribution: b.c.credit };
        }
      }
    }

    if (got.length) {
      o.files[i] = got;
      replaced++;
    }
    const lead = best[0]?.score ?? 0;
    if (got.length && lead >= SCENE_BAR) {
      log(`  scene ${scene.id}: ${lead}/10 ✓ (${got.length} shot${got.length > 1 ? "s" : ""})`);
    } else {
      failed.push(scene.id);
      log(`  scene ${scene.id}: ${lead}/10 — below ${SCENE_BAR}; ${got.length ? "using the best available" : "keeping the originally fetched footage"}`);
    }
  }
  if (unjudged.length) {
    log(`  vision ${visionSpent >= VISION_BUDGET ? `budget (${VISION_BUDGET})` : "quota"} reached — ${unjudged.length} scene(s) keep their fetched footage unjudged: ${unjudged.join(", ")}`);
  }
  return { passed: o.scenes.length - failed.length - unjudged.length, failed, replaced, unjudged, autoPicked };
}
