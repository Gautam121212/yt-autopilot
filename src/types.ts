import { z } from "zod";

export const TopicSchema = z.object({
  chosen: z.object({
    workingTitle: z.string(),
    subject: z.string(),
    angle: z.string(),
    hook: z.string(),
    mentalModel: z.string().describe("the idea the viewer will understand afterwards"),
    demandEvidence: z.string().describe("which outlier videos show audience demand for this, and how our angle differs"),
    /** The single funniest TRUE detail. A topic without one cannot carry this channel. */
    funniestDetail: z.string().min(10),
    /** The whole video in one sentence a stranger would repeat at a dinner table. */
    premise: z.string().min(15).max(300),
    /** CONCRETE, FILMABLE things this story can be shown with. Checked against the stock libraries
     *  before a single script credit is spent: no footage, no video. Floor kept low so one missing
     *  item never bins an otherwise good topic — the filmability gate is what actually enforces it. */
    visualSubjects: z.array(z.string()).min(5).max(14),
    scores: z.object({
      absurdity: z.number().min(0).max(10).describe("how indefensible/ridiculous the true events are"),
      retellability: z.number().min(0).max(10).describe("would a viewer retell this to someone else today"),
      curiosity: z.number().min(0).max(10).describe("would a stranger stop scrolling for this"),
      evidence: z.number().min(0).max(10).describe("how well documented in encyclopedic sources"),
      illustratability: z.number().min(0).max(10).describe("how many scenes can be real stock footage or archive photos"),
      freshness: z.number().min(0).max(10).describe("how unlike the channel's existing videos and the outlier list"),
    }),
    wikipediaQueries: z.array(z.string()).min(2).max(4),
  }),
  rejected: z.array(z.object({ workingTitle: z.string(), reason: z.string() })).default([]),
});
export type Topic = z.infer<typeof TopicSchema>;

export const DossierSchema = z
  .object({
    summary: z.string(),
    sources: z.array(z.object({ id: z.string(), url: z.string().url(), title: z.string() })).min(2),
    keyFacts: z.array(z.object({ fact: z.string(), sourceIds: z.array(z.string()).min(1) })).min(8),
    /** Sourced narrative colour: named people, times of day, what was seen or heard, exact objects.
     *  Without this the writer invents it, and the fact-checker then kills a good script. */
    details: z.array(z.object({ detail: z.string(), sourceIds: z.array(z.string()).min(1) })).min(6),
    figures: z.array(z.object({ claim: z.string(), value: z.string(), sourceIds: z.array(z.string()).min(1) })),
    mentalModel: z.string().describe("the one idea the viewer should walk away understanding"),
    uncertain: z.array(z.string()).default([]).describe("open questions / hypotheses, never to be stated as fact"),
  })
  .refine((d) => {
    const ids = new Set(d.sources.map((s) => s.id));
    return [...d.keyFacts, ...d.figures].every((x) => x.sourceIds.every((id) => ids.has(id)));
  }, "Every sourceId must reference an entry in sources");
export type Dossier = z.infer<typeof DossierSchema>;

/** The fixed beat sheet every video follows. Content changes; the structure never does. */
export const SCENE_ROLES = ["cold_open", "reaction", "premise", "escalation", "turn", "mechanism", "payoff", "kicker"] as const;

export const SceneSchema = z.object({
  id: z.string(),
  role: z.enum(SCENE_ROLES).describe("its job in the beat sheet"),
  chapter: z.string().optional().describe("set only on scenes that start a new chapter"),
  narration: z.string(),
  imageQuery: z.string().describe("2-5 word photo-archive search naming ONE concrete object"),
  altQueries: z.array(z.string()).min(2).max(3).describe("two or three DIFFERENT concrete objects that could illustrate the same line"),
  motion: z.enum(["still", "clip"]).describe("'clip' for scenes describing movement, process or scale; 'still' otherwise"),
  era: z.enum(["historical", "modern", "any"]).describe("'historical' for anything before ~1950 — forces period artwork and blocks modern stock photos"),
  cardHeadline: z.string().max(40).describe("2-5 words, ideally the scene's key figure ('800 MILES', '2 HOURS'); shown as a designed card when no honest photo exists"),
  cardSub: z.string().max(90).describe("one short clause explaining the headline"),
  claimIds: z.array(z.string()).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

const WORDS = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export const ScriptSchema = z.object({
  title: z.string().max(100),
  altTitles: z.array(z.string().max(100)).length(3),
  description: z.string().max(2500),
  tags: z.array(z.string()).max(15),
  thumbnailText: z.string().max(32),
  thumbnailQuery: z.string(),
  scenes: z.array(SceneSchema).min(12).max(18),   // enforced: more scenes means a slower render and weaker pictures
  short: z.object({
    title: z.string().max(90),
    scenes: z.array(z.object({
      id: z.string(),
      role: z.enum(["cold_open", "escalation", "payoff", "kicker"]),
      narration: z.string(), imageQuery: z.string(),
      altQueries: z.array(z.string()).min(2).max(3),
      motion: z.enum(["still", "clip"]),
      era: z.enum(["historical", "modern", "any"]),
      cardHeadline: z.string().max(40),
      cardSub: z.string().max(90),
    })).min(3).max(8),
  }),
  claims: z.array(z.object({ id: z.string(), text: z.string(), sourceIds: z.array(z.string()).min(1) })),
})
  // The beat sheet is mandatory: this is what stops every video being a shapeless list of facts.
  .refine((s) => s.scenes[0]?.role === "cold_open", "Scene 1 must be the cold_open")
  .refine((s) => s.scenes[1]?.role === "reaction", "Scene 2 must be the deadpan reaction to the cold open")
  .refine((s) => s.scenes.some((sc) => sc.role === "premise"), "There must be a premise scene")
  .refine((s) => s.scenes.filter((sc) => sc.role === "escalation").length >= 3, "There must be at least 3 escalation scenes")
  .refine((s) => s.scenes.some((sc) => sc.role === "turn"), "There must be a turn — the moment it goes wrong or gets strange")
  .refine((s) => s.scenes.some((sc) => sc.role === "mechanism"), "There must be a mechanism scene that explains the real science")
  .refine((s) => s.scenes.at(-1)?.role === "kicker", "The last scene must be the kicker — the best absurd detail, held back")
  ;

/** Total narration words. Length is fixed by an expand pass, not by rejecting the script. */
export const scriptWords = (s: { scenes: { narration: string }[] }) =>
  s.scenes.reduce((n, sc) => n + WORDS(sc.narration), 0);
export const MIN_WORDS = 1000;
export type Script = z.infer<typeof ScriptSchema>;

export const VerifySchema = z.object({
  verdict: z.enum(["pass", "revise", "abandon"]),
  adSuitability: z.enum(["likely_full", "likely_limited", "unsuitable"]),
  issues: z.array(z.object({
    sceneId: z.string().nullable(),
    category: z.enum(["factual", "misinformation", "misleading_metadata", "advertiser_friendly", "inauthentic_risk", "quality"]),
    severity: z.enum(["blocker", "major", "minor"]),
    problem: z.string(),
    fix: z.string(),
  })),
  summary: z.string(),
});
export type Verification = z.infer<typeof VerifySchema>;

export type SceneTiming = { sceneId: string; start: number; end: number; speechSec: number };
