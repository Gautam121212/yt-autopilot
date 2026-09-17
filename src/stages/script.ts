import type { ChannelConfig } from "../config";
import { askJson } from "../lib/llm";
import { ScriptSchema, type Dossier, type Script, type Topic, type Verification } from "../types";

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

STRUCTURE
1. Open mid-absurdity, first sentence. A person doing something indefensible, or a number that cannot be right.
   Then one line of deadpan reaction. Only then explain.
2. Total ${minM * cfg.wordsPerMinute}-${maxM * cfg.wordsPerMinute} words. HARD LIMIT 14-18 scenes, 70-95 words each.
3. Every 60-90 seconds: a reversal, an escalation, or a small joke at reality's expense.
4. Land the real science properly. The viewer should leave having genuinely learned the mechanism.
5. End on the best absurd detail you held back, not on a summary.

HARD RULES
6. Every factual statement is backed by a claim whose sourceIds exist in the dossier. Never invent numbers,
   dates, names or quotes. Items in dossier.uncertain are framed as open questions.
7. imageQuery: 2-5 words naming a CONCRETE, FILMABLE thing — an object, place, animal, machine, building, document.
   Prefer things stock footage libraries actually hold: hands doing something, liquid pouring, machinery turning,
   weather, crowds of animals, laboratory glassware, city streets, food, tools, water, fire, sky.
   NEVER: magnified textures, "group photo", people posing, brand-name products, abstractions.
   altQueries: 2-3 different concrete things that would illustrate the same line.
8. motion: "clip" whenever the line has movement, process, scale or atmosphere — aim for MOST scenes to be "clip".
   "still" only for a specific historical object or document that must be seen exactly.
9. era: "historical" only when the subject is pre-1950 AND must look period. Prefer "any" so modern footage is allowed.
10. cardHeadline / cardSub: a short punchy figure ("2 LITRES A DAY", "411 SHIPS") used as an on-screen caption over
   footage — NOT a slide. Keep it under 4 words. Write one for every scene anyway; most will go unused.
11. No "in this video", no greetings, at most one soft subscribe mention at the very end.

PLAYBOOK (learned from this channel's own data; follow unless it conflicts with the hard rules)
${playbook}`;
}

const SHAPE = `JSON: { "title", "altTitles": [3], "description" (2-3 short paragraphs, no links), "tags": [<=15], "thumbnailText" (2-4 words),
"thumbnailQuery" (a concrete photo search for the thumbnail), "scenes": [{ "id": "sc01", "chapter"?, "narration", "imageQuery", "altQueries": [2-3], "motion": "still"|"clip", "era": "historical"|"modern"|"any", "cardHeadline", "cardSub", "claimIds" }],
"claims": [{ "id": "C1", "text", "sourceIds" }], "short": { "title", "scenes": [{ "id": "sh01", "narration", "imageQuery", "altQueries": [2-3], "motion": "still"|"clip", "era": "historical"|"modern"|"any", "cardHeadline", "cardSub" }] } }`;

export async function writeScript(o: {
  cfg: ChannelConfig; playbook: string; structure: { id: string; description: string };
  topic: Topic; dossier: Dossier; recent: { title: string; hook: string }[];
  /** set when an earlier draft was rejected, so the new one avoids the same faults */
  critique?: string;
}): Promise<Script> {
  return askJson({
    tier: "heavy",
    schema: ScriptSchema,
    system: system(o.cfg, o.playbook),
    prompt: `Structure: ${o.structure.id} - ${o.structure.description}
Working title: ${o.topic.chosen.workingTitle}
Hook idea: ${o.topic.chosen.hook}
Angle: ${o.topic.chosen.angle}

Recent uploads - do NOT reuse their title template, opening-line pattern or hook device:
${o.recent.map((r) => `- "${r.title}" | opened with: "${r.hook.slice(0, 160)}"`).join("\n") || "- (none yet)"}

DOSSIER:
${JSON.stringify(o.dossier)}
${o.critique ? `\nWHAT WENT WRONG LAST TIME:\n${o.critique}\n` : ""}
${SHAPE}`,
  });
}

/** Targeted rewrite driven by the final check's issues; everything not mentioned must stay byte-identical. */
export async function repairScript(o: {
  cfg: ChannelConfig; playbook: string; script: Script; dossier: Dossier;
  issues: { severity: string; area: string; sceneId: string | null; what: string; fix: string }[];
}): Promise<Script> {
  return askJson({
    tier: "heavy",
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
  });
}

export async function reviseScript(o: { cfg: ChannelConfig; playbook: string; script: Script; dossier: Dossier; verification: Verification }): Promise<Script> {
  return askJson({
    tier: "heavy",
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
  });
}
