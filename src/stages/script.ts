import type { ChannelConfig } from "../config";
import { askJson } from "../lib/llm";
import { scriptLessons } from "../lib/lessons";
import { ScriptSchema, TARGET_SCENES, type Dossier, type Script, type Topic, type Verification } from "../types";

function system(cfg: ChannelConfig, playbook: string) {
  const [minM, maxM] = cfg.targetMinutes;
  return `You are the head writer of "${cfg.channelName}": science and history told like the best story your funniest
friend knows. Funny AND true. The humour comes from the facts being absurd, never from jokes bolted on.

THE VOICE — this is the whole channel
- Deadpan. State the ridiculous thing plainly and let it land. "So he drank it. Obviously he drank it."
- React like a person: "which went about as well as you'd expect", "nobody stopped him", "this was considered fine".
- Undercut your own build-ups. Set up a grand mechanism, then admit the bit nobody solved.
- Be on the viewer's side against the absurdity: "yes, that is a real unit of measurement".
- Short punchy sentences next to one long winding one. Rhythm is the joke's delivery.
- NEVER: "moreover", "furthermore", "it is important to note", "this phenomenon", "plays a crucial role",
  "delve into", "in conclusion", "fascinating", "mind-blowing", "let that sink in".
- No puns, no "buckle up", no forced enthusiasm, no exclamation marks. Dry beats loud.
- Accuracy is non-negotiable: the funniest version of a true fact, never a funnier untrue one.

THE BEAT SHEET — every video uses exactly this shape. Each scene declares its "role":
1. cold_open — a person doing something indefensible, or a number that cannot be right. No context yet.
2. reaction — one deadpan beat acknowledging what just happened. Short.
3. premise — what this video is actually about, in the viewer's language. The promise.
4-8. escalation (at least 3) — each one raises the stakes or the absurdity, each ending on something unresolved.
9. turn — the moment it goes wrong, or stops being funny and becomes interesting.
10. mechanism — the real science or engineering, explained properly. This is why the video exists.
11. payoff — the promise from the premise, delivered.
12. kicker (last scene) — the best absurd detail, deliberately held back until now.
You may repeat escalation and mechanism as needed to fill 13-16 scenes.

LENGTH — writers miss this more than any other rule, so work to a PER-SCENE budget, not a total.
Write each scene to its own quota and the total takes care of itself:

  role         how many   words each
  cold_open        1        60-75    (a hook, not an essay)
  reaction         1        45-60    (one beat; the shortest scene in the video)
  premise          1        85-100
  escalation      5-7       90-110   (the body of the video — these carry the length)
  turn             1        90-110
  mechanism       2-3      110-130   (the longest scenes: the real explanation lives here)
  payoff           1        85-100
  kicker           1        60-80    (land it and stop)

That is 13-16 scenes: count them before answering. FEWER THAN 13 SCENES IS REJECTED.
${minM * cfg.wordsPerMinute}-${maxM * cfg.wordsPerMinute} words in total.
HARD FLOOR: ${minM * cfg.wordsPerMinute} words total, and no scene under 45 words.

Before answering, count the words in each scene and compare it against its quota above. A 600-word
script is thrown away however good it reads, because the video is unpublishable at that length.
Write full paragraphs of flowing narration — never bullet points rendered as prose, never a summary
of what the scene would say.

HARD RULES
6. Every factual statement is backed by a claim whose sourceIds exist in the dossier. Never invent numbers,
   dates, names or quotes. Items in dossier.uncertain are framed as open questions.
   THIS INCLUDES COLOUR. Vivid specifics are the point of this channel, but every one must come from
   dossier.details or dossier.keyFacts. Do not add an eyewitness, a time of day, a piece of equipment, a weather
   condition or a small dramatic beat that is not in the dossier — a script that does this gets thrown away
   however good it reads. If the dossier lacks colour for a scene, write the scene drier rather than inventing it.
7. imageQuery — THE HARD RULE OF THIS CHANNEL.
   You are given a list of APPROVED VISUAL SUBJECTS that have already been checked against the real stock
   libraries. Every scene's imageQuery MUST be one of them, word for word. altQueries must also come from
   that list (different entries). You may reuse a subject across scenes.
   Inventing your own search — however sensible it reads — is what makes videos fail: the picture does not
   exist and the scene ends up showing something unrelated. If no approved subject fits a scene, rewrite the
   scene so an approved subject does fit.
   For reference, the old rule (now superseded by the list): 2-5 words naming a CONCRETE, FILMABLE thing — an object, place, animal, machine, building, document.
   Prefer things stock footage libraries actually hold: hands doing something, liquid pouring, machinery turning,
   weather, crowds of animals, laboratory glassware, city streets, food, tools, water, fire, sky.
   NEVER: magnified textures, "group photo", people posing, brand-name products, abstractions.
   altQueries: 2-3 different concrete things that would illustrate the same line.
8. motion: "clip" whenever the line has movement, process, scale or atmosphere — aim for MOST scenes to be "clip".
   "still" only for a specific historical object or document that must be seen exactly.
9. era: "historical" only when the subject is pre-1950 AND must look period. Prefer "any" so modern footage is allowed.
10. thumbnailText: the punchline of the video in 2-5 words, written as a REACTION, not a description.
   It is rendered as two lines: a setup then a payoff in yellow. Good: "HE DRANK IT / ON PURPOSE",
   "NOBODY STOPPED HIM", "411 SHIPS / SANK ON PURPOSE", "IT WORKED". Bad: "The History of Plimsoll Lines",
   "Understanding Digestion". Use only words that appear in the narration, plus everyday words.
   thumbnailQuery: the single most absurd CONCRETE object or scene in the story — what a viewer should see.
11. cardHeadline / cardSub: a short punchy figure ("2 LITRES A DAY", "411 SHIPS") used as an on-screen caption over
   footage — NOT a slide. Keep it under 4 words. Write one for every scene anyway; most will go unused.
12. No "in this video", no greetings, at most one soft subscribe mention at the very end.

PLAYBOOK (learned from this channel's own data; follow unless it conflicts with the hard rules)
${playbook}`;
}

const SHAPE = `JSON: { "title", "altTitles": [3], "description" (2-3 short paragraphs, no links), "tags": [<=15], "thumbnailText" (2-4 words),
"thumbnailQuery" (a concrete photo search for the thumbnail), "scenes": [{ "id": "sc01", "role": "cold_open"|"reaction"|"premise"|"escalation"|"turn"|"mechanism"|"payoff"|"kicker", "chapter"?, "narration", "imageQuery", "altQueries": [2-3], "motion": "still"|"clip", "era": "historical"|"modern"|"any", "cardHeadline", "cardSub", "claimIds" }],
"claims": [{ "id": "C1", "text", "sourceIds" }], "short": { "title", "scenes": [{ "id": "sh01", "role": "cold_open"|"escalation"|"payoff"|"kicker", "narration", "imageQuery", "altQueries": [2-3], "motion": "still"|"clip", "era": "historical"|"modern"|"any", "cardHeadline", "cardSub" }] } }`;

/**
 * Bring a script up to TARGET_SCENES by splitting its longest body scenes at a sentence boundary.
 *
 * Deterministic and free. Only escalation and mechanism scenes are split, and the new half is
 * inserted directly after its parent with the same role — which cannot break any beat-sheet rule
 * (cold_open first, reaction second, kicker last, minimum counts). The second half gets the next
 * approved image query, so the cut lands on a new picture rather than the same one twice.
 */
export function normaliseSceneCount<T extends Script>(script: T): T {
  const scenes = [...script.scenes];
  const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
  const sentences = (t: string) => t.match(/[^.!?]+[.!?]+(?:["')\]]+)?\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [t];
  let splits = 0;

  while (scenes.length < TARGET_SCENES) {
    // the longest splittable scene that has at least two sentences to divide
    const candidates = scenes
      .map((sc, i) => ({ sc, i, w: words(sc.narration), parts: sentences(sc.narration) }))
      .filter((x) => (x.sc.role === "escalation" || x.sc.role === "mechanism") && x.parts.length >= 2);
    if (!candidates.length) break;
    const pick = candidates.sort((a, b) => b.w - a.w)[0]!;

    // cut at the sentence boundary closest to half the words
    let acc = 0, cut = 1;
    for (let k = 0; k < pick.parts.length - 1; k++) {
      acc += words(pick.parts[k]!);
      if (acc >= pick.w / 2) { cut = k + 1; break; }
      cut = k + 1;
    }
    const first = pick.parts.slice(0, cut).join(" ");
    const second = pick.parts.slice(cut).join(" ");
    if (!first || !second) break;

    const alts = pick.sc.altQueries ?? [];
    const a = { ...pick.sc, narration: first };
    const b = {
      ...pick.sc,
      id: `${pick.sc.id}b${++splits}`,
      narration: second,
      imageQuery: alts[0] ?? pick.sc.imageQuery,
      altQueries: [...alts.slice(1), pick.sc.imageQuery].slice(0, 3),
    };
    scenes.splice(pick.i, 1, a, b);
  }

  if (splits) console.log(`  scene count: split ${splits} long scene(s) to reach ${scenes.length} (target ${TARGET_SCENES})`);
  return { ...script, scenes };
}

export async function writeScript(o: {
  cfg: ChannelConfig; playbook: string; structure: { id: string; description: string };
  topic: Topic; dossier: Dossier; recent: { title: string; hook: string }[];
  /** set when an earlier draft was rejected, so the new one avoids the same faults */
  critique?: string;
}): Promise<Script> {
  const lessons = await scriptLessons();
  return normaliseSceneCount(await askJson({
    tier: "heavy",
    role: "write",
    schema: ScriptSchema,
    system: system(o.cfg, o.playbook),
    prompt: `${lessons ? `${lessons}\n\n` : ""}Structure: ${o.structure.id} - ${o.structure.description}
Working title: ${o.topic.chosen.workingTitle}
Hook idea: ${o.topic.chosen.hook}
Angle: ${o.topic.chosen.angle}

Recent uploads - do NOT reuse their title template, opening-line pattern or hook device:
${o.recent.map((r) => `- "${r.title}" | opened with: "${r.hook.slice(0, 160)}"`).join("\n") || "- (none yet)"}

APPROVED VISUAL SUBJECTS — every imageQuery and altQuery must be taken from this list, verbatim:
${(o.topic.chosen.visualSubjects ?? []).map((v) => `- ${v}`).join("\n")}

DOSSIER:
${JSON.stringify(o.dossier)}
${o.critique ? `\nWHAT WENT WRONG LAST TIME:\n${o.critique}\n` : ""}
${SHAPE}`,
  }));
}

/** Targeted rewrite driven by the final check's issues; everything not mentioned must stay byte-identical. */
export async function repairScript(o: {
  cfg: ChannelConfig; playbook: string; script: Script; dossier: Dossier;
  issues: { severity: string; area: string; sceneId: string | null; what: string; fix: string }[];
}): Promise<Script> {
  return normaliseSceneCount(await askJson({
    tier: "heavy",
    role: "judge",
    schema: ScriptSchema,
    system: system(o.cfg, o.playbook),
    prompt: `A reviewer watched the finished video and refused to publish it. Fix exactly what they listed.

RULES FOR THIS REPAIR
- Change only what the issues require. Scenes not named keep their narration and imageQuery unchanged.
- If the hook is criticised, rewrite the first 2-3 scenes so the first sentence carries a concrete, specific fact.
- If a scene's image is wrong, rewrite that scene's imageQuery to name a different concrete photographable object.
- If the title or thumbnail text is criticised, replace them with accurate, more compelling versions.
- Every factual statement still has to trace to the dossier.

ISSUES:
${JSON.stringify(o.issues, null, 1)}

DOSSIER:
${JSON.stringify(o.dossier)}

CURRENT SCRIPT:
${JSON.stringify(o.script)}

Return the complete repaired script. ${SHAPE}`,
  }));
}

/**
 * Last resort before abandoning: delete or soften every claim the reviewer could not trace to the
 * dossier, changing nothing else. Cheaper and better than throwing away a script that works.
 */
export async function stripUnsourced(o: { cfg: ChannelConfig; playbook: string; script: Script; dossier: Dossier; issues: { what: string; fix: string }[] }): Promise<Script> {
  return normaliseSceneCount(await askJson({
    tier: "heavy",
    role: "judge",
    schema: ScriptSchema,
    system: system(o.cfg, o.playbook),
    prompt: `A fact-checker found details in this script that are not in the dossier. Your ONLY job is to remove or
rewrite those specific details so every sentence traces to the dossier. Do not restructure, do not re-voice, do not
change the hook, do not touch anything the checker did not flag. Where a flagged detail carried a joke, keep the
joke using a detail that IS in the dossier, or cut the sentence entirely. The script must still meet the word count.

FLAGGED:
${o.issues.map((i) => `- ${i.what} -> ${i.fix}`).join("\n")}

DOSSIER (the only permitted source of facts):
${JSON.stringify(o.dossier)}

SCRIPT:
${JSON.stringify(o.script)}

Return the complete corrected script. ${SHAPE}`,
  }));
}

/**
 * Comedy pass. One prompt asking for "humour" alongside 12 other rules produces history with a
 * joke bolted on. This pass does ONE job: rewrite the narration so it sounds like a person being
 * dry, changing no facts and no structure. Run after the script, before the fact check.
 */
/**
 * Expand pass. The writer reliably under-writes when it is also juggling the beat sheet, sources and
 * image queries. Rejecting the script for that wastes the most expensive call in the pipeline, so
 * instead we hand it back and ask only for length — same scenes, same facts, more detail.
 */
export async function expandScript(o: { cfg: ChannelConfig; playbook: string; script: Script; dossier: Dossier; words: number }): Promise<Script> {
  const [minM, maxM] = o.cfg.targetMinutes;
  const targetWords = Math.round(((minM + maxM) / 2) * o.cfg.wordsPerMinute);
  return normaliseSceneCount(await askJson({
    tier: "heavy",
    role: "write",
    schema: ScriptSchema,
    system: system(o.cfg, o.playbook),
    prompt: `This script is too short: ${o.words} words, and it needs about ${targetWords} (${minM}-${maxM} minutes).

Your ONLY job is to lengthen it. Keep every scene, its id, its role, its order, its imageQuery, altQueries,
motion, era, cardHeadline and cardSub exactly as they are. Keep the title and thumbnailText.

SCENES THAT ARE SHORT, with their targets — fix these specifically:
${o.script.scenes
  .map((sc) => ({ sc, w: sc.narration.trim().split(/\s+/).filter(Boolean).length }))
  .filter((x) => x.w < 85)
  .map((x) => `- ${x.sc.id} (${x.sc.role}): ${x.w} words -> needs ${x.sc.role === "mechanism" ? "110-130" : x.sc.role === "reaction" || x.sc.role === "cold_open" || x.sc.role === "kicker" ? "60-80" : "90-110"}`)
  .join("\n")}

Bring every listed scene to its target by adding material that is already in the dossier: the specific numbers, the
named people, the times of day, what people saw, what the equipment did, the bureaucratic aftermath. Where the
dossier has a detail you skipped, use it. Add a deadpan beat where one fits. Do NOT invent facts, do NOT add
scenes, do NOT restate the same point twice to pad.

DOSSIER (the only permitted source of facts):
${JSON.stringify(o.dossier)}

SCRIPT:
${JSON.stringify(o.script)}

Return the complete lengthened script. ${SHAPE}`,
  }));
}

export async function punchUp(o: { cfg: ChannelConfig; script: Script; dossier: Dossier }): Promise<Script> {
  return normaliseSceneCount(await askJson({
    tier: "heavy",
    role: "write",
    schema: ScriptSchema,
    system: `You are a comedy writer doing a punch-up pass on a documentary script. The facts are already correct
and already sourced. Your ONLY job is the voice.

WHAT TO DO, scene by scene
- Cut every academic connective. "Moreover", "this phenomenon", "it is important to note", "plays a crucial role",
  "researchers have long", "delve into", "fascinating" — gone.
- Add a reacting human. After a ridiculous fact, one short line acknowledging it: "So he drank it." / "Nobody
  stopped him." / "This was considered fine." / "Which went about as well as you'd expect." / "Yes, that is a real
  unit of measurement."
- Put the absurd noun at the END of the sentence, where the laugh is. Not "a plug made of lead was used to prevent
  boiler explosions" but "to stop the boiler exploding, they relied on a plug. Made of lead."
- Break long sentences. Let one short sentence land alone. Rhythm is the delivery.
- Deadpan understatement over enthusiasm. Never exclamation marks, never puns, never "buckle up", never
  "mind-blowing". The facts are doing the work; you are just not getting in their way.
- Talk to the viewer where it is true: "you would have signed it too."
- ONE IDEA PER SENTENCE. The edit cuts to a new picture at every full stop, so a sentence carrying two
  subjects breaks the sync between what is heard and what is seen.
- Keep the explanation intact. This is funny science, not comedy instead of science.

HARD LIMITS
- Change NO facts, figures, names or dates. Add nothing that is not already in the script or the dossier.
- Keep the same scenes, same ids, same order, same imageQuery/altQueries/motion/era/cardHeadline/cardSub values.
- Keep total narration within 15% of its current length, and every scene above 45 words.
- Title and thumbnailText may be sharpened; they must stay accurate.`,
    prompt: `DOSSIER (the only permitted facts):
${JSON.stringify(o.dossier)}

SCRIPT TO PUNCH UP:
${JSON.stringify(o.script)}

Return the complete script with the narration rewritten. ${SHAPE}`,
  }));
}

export async function reviseScript(o: { cfg: ChannelConfig; playbook: string; script: Script; dossier: Dossier; verification: Verification }): Promise<Script> {
  return normaliseSceneCount(await askJson({
    tier: "heavy",
    role: "judge",
    schema: ScriptSchema,
    system: system(o.cfg, o.playbook),
    prompt: `A standards editor reviewed your script. Fix EVERY blocker and major issue, and minor ones where cheap. Keep everything else intact.

ISSUES:
${JSON.stringify(o.verification.issues, null, 1)}

DOSSIER:
${JSON.stringify(o.dossier)}

CURRENT SCRIPT:
${JSON.stringify(o.script)}

Return the complete revised script. ${SHAPE}`,
  }));
}
