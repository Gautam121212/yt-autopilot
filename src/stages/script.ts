import type { ChannelConfig } from "../config";
import { askJson } from "../lib/llm";
import { ScriptSchema, type Dossier, type Script, type Topic, type Verification } from "../types";

function system(cfg: ChannelConfig, playbook: string) {
  const [minM, maxM] = cfg.targetMinutes;
  return `You are the head writer of "${cfg.channelName}", a YouTube channel: ${cfg.niche}.
You write narration for one voice-over. Spoken English: short sentences, vivid comparisons, zero filler.

HARD RULES
1. Long video: ${minM * cfg.wordsPerMinute}-${maxM * cfg.wordsPerMinute} words of narration in total, scenes of 30-60 words.
2. Every factual statement is backed by a claim in "claims" whose sourceIds exist in the dossier; scenes list their claimIds.
   Never invent numbers, dates, names or quotes. Items in dossier.uncertain must be framed as open questions or hypotheses.
3. Teach the mental model explicitly. Use human-scale comparisons for big numbers. This original explanation is the channel's value; it must not read like a Wikipedia summary.
4. imageQuery for each scene: 2-5 words naming a CONCRETE, PHOTOGRAPHABLE thing that exists in public photo archives
   (an object, place, animal, plant, machine, building, document, diagram, historical artefact). Use the specific noun a
   photo would be filed under ("Trinity College library", "Atlantic puffin", "vacuum tube"), never an abstraction
   ("the power of ideas"), never a named living person, never a logo or brand. Vary queries across scenes.
   altQueries: 2-3 DIFFERENT concrete objects that could illustrate the same line, so the search has alternatives
   if the first finds nothing ("sugar cube in water" / "salt crystal macro" / "limestone cave pool").
   motion: "clip" when the line describes movement, a process, scale or a place you would pan across
   (water flowing, machinery turning, a storm, a crowd of stars); "still" for objects, documents and portraits of things.
   Aim for roughly one "clip" in every three scenes. A "clip" scene must be era "modern" or "any" —
   stock video is always modern footage, so never mark a pre-1950 subject as "clip".
   cardHeadline / cardSub: what this scene should say as a DESIGNED CARD if no honest photograph exists.
   Headline is 2-5 words, ideally the scene's key number ("800 MILES", "2 HOURS", "NINE SECONDS"); cardSub is one
   short clause. Write these for every scene — a card is always better than a picture of the wrong thing.
   era: "historical" for any subject before about 1950 (it forces period engravings and photographs and blocks
   modern stock), "modern" for present-day subjects, "any" for timeless objects and landscapes.
   NEVER request: anything "under a microscope" or magnified beyond a normal photo; a "group photo" or any
   query containing people, workers, crowds or portraits; a texture with no subject ("fibers", "grain", "surface");
   a brand-name product (a fridge, a car) since those carry logos. Ask for the OBJECT or the PLACE instead
   ("ice house barn", "sawdust pile", "harbour warehouse", "ledger page").
   When a scene uses an analogy or metaphor, the imageQuery names the LITERAL object of the analogy
   ("sugar cube dissolving in water", not "dissolution"); when it describes an event with no photo
   (an evacuation, a decision, a calculation), name a concrete object from that setting
   ("underground mine tunnel", "emergency siren"), never a dramatic stand-in like a fire or an explosion.
5. 5-8 scenes carry a short "chapter" title; the first scene must have one.
6. Title and thumbnail text are accurate: no exaggeration, no promise the video doesn't keep, no fake urgency.
7. No "in this video", no greetings, at most one soft subscribe mention at the very end.
8. Also write a SHORT: a standalone 110-150 word vertical video (4-7 scenes) on the single most surprising fact, ending with a line that makes people want the full video. Same sourcing rules.

PLAYBOOK (from this channel's own data; follow unless it conflicts with the hard rules)
${playbook}`;
}

const SHAPE = `JSON: { "title", "altTitles": [3], "description" (2-3 short paragraphs, no links), "tags": [<=15], "thumbnailText" (2-4 words),
"thumbnailQuery" (a concrete photo search for the thumbnail), "scenes": [{ "id": "sc01", "chapter"?, "narration", "imageQuery", "altQueries": [2-3], "motion": "still"|"clip", "era": "historical"|"modern"|"any", "cardHeadline", "cardSub", "claimIds" }],
"claims": [{ "id": "C1", "text", "sourceIds" }], "short": { "title", "scenes": [{ "id": "sh01", "narration", "imageQuery", "altQueries": [2-3], "motion": "still"|"clip", "era": "historical"|"modern"|"any", "cardHeadline", "cardSub" }] } }`;

export async function writeScript(o: {
  cfg: ChannelConfig; playbook: string; structure: { id: string; description: string };
  topic: Topic; dossier: Dossier; recent: { title: string; hook: string }[];
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
