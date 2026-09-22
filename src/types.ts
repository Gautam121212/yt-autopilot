import { z } from "zod";

/** Below this a script is not worth salvaging. */
// ── Normalise, don't reject (#11, #48, #50, #75) ─────────────────────────────────────────────
// Every constraint below used to throw away a complete, good script over formatting: 4 alternative
// titles instead of 3, 18 tags instead of 15, a caption a few characters long, "Clip" instead of
// "clip". Each rejection cost a heavy call and usually a retry. Anything code can fix, code fixes.

/** Cut at a word boundary, so a caption never ends mid-word. */
const fit = (max: number) => z.string().transform((x) => {
  const t = x.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim();
});
/** Lowercase, trim, spaces/hyphens to underscores, then map onto an allowed value. */
const enumish = <T extends readonly [string, ...string[]]>(allowed: T, aliases: Record<string, T[number]>, fallback: T[number]) =>
  z.preprocess((v) => {
    const k = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    return (allowed as readonly string[]).includes(k) ? k : aliases[k] ?? fallback;
  }, z.enum(allowed));
const MOTION = enumish(["still", "clip"] as const, { video: "clip", moving: "clip", motion: "clip", footage: "clip", photo: "still", image: "still", picture: "still", static: "still" }, "still");
const ERA = enumish(["historical", "modern", "any"] as const, { ancient: "historical", old: "historical", past: "historical", period: "historical", vintage: "historical", present: "modern", contemporary: "modern", current: "modern", timeless: "any", none: "any" }, "any");
/** 1+ queries accepted; brought to 2-3 (a duplicate is harmless, searches are deduplicated). */
const QUERIES = z.array(z.string()).min(1).transform((a) => (a.length >= 2 ? a : [...a, a[0]!]).slice(0, 3));

export const MIN_SCHEMA_SCENES = 9;
/** What every script is brought up to before production — by splitting, not by asking again. */
export const TARGET_SCENES = 13;

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
    // Models return either ["a doubt"] or [{ claim: "...", why: "..." }]. Both are fine; we flatten.
    uncertain: z.array(z.union([z.string(), z.record(z.any())]))
      .default([])
      .transform((xs) => xs.map((x) => (typeof x === "string" ? x : Object.values(x).filter((v) => typeof v === "string").join(" — "))))
      .describe("open questions / hypotheses, never to be stated as fact"),
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
  role: enumish(SCENE_ROLES, { hook: "cold_open", opening: "cold_open", intro: "cold_open", setup: "premise", reveal: "turn", twist: "turn", explanation: "mechanism", science: "mechanism", resolution: "payoff", ending: "kicker", outro: "kicker", punchline: "kicker" }, "escalation").describe("its job in the beat sheet"),
  chapter: z.string().optional().describe("set only on scenes that start a new chapter"),
  narration: z.string(),
  imageQuery: z.string().describe("2-5 word photo-archive search naming ONE concrete object"),
  altQueries: QUERIES.describe("two or three DIFFERENT concrete objects that could illustrate the same line"),
  motion: MOTION.describe("'clip' for scenes describing movement, process or scale; 'still' otherwise"),
  era: ERA.describe("'historical' for anything before ~1950 — forces period artwork and blocks modern stock photos"),
  cardHeadline: fit(40).describe("2-5 words, ideally the scene's key figure ('800 MILES', '2 HOURS'); burned in small over the footage as a figure caption"),
  cardSub: fit(90).describe("one short clause explaining the headline"),
  claimIds: z.array(z.string()).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

const WORDS = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export const ScriptSchema = z.object({
  title: fit(100),
  // any number accepted; YouTube needs one title, the rest are A/B candidates — exactly 3 is kept
  altTitles: z.array(fit(100)).min(1).transform((a) => [...a, ...a, ...a].slice(0, 3)),
  description: fit(2500),
  tags: z.array(z.string()).transform((a) => a.slice(0, 15)),
  thumbnailText: fit(32),
  thumbnailQuery: z.string(),
  // The schema accepts any SALVAGEABLE script. Rejecting a complete 11-scene script over its count
  // wasted three heavy calls; `normaliseSceneCount` splits long scenes up to 13 for free instead.
  scenes: z.array(SceneSchema).min(MIN_SCHEMA_SCENES).max(18),
  short: z.object({
    title: fit(90),
    scenes: z.array(z.object({
      id: z.string(),
      role: enumish(["cold_open", "escalation", "payoff", "kicker"] as const, { hook: "cold_open", premise: "escalation", reaction: "escalation", turn: "escalation", mechanism: "escalation", punchline: "kicker", ending: "kicker" }, "escalation"),
      narration: z.string(), imageQuery: z.string(),
      altQueries: QUERIES,
      motion: MOTION,
      era: ERA,
      cardHeadline: fit(40),
      cardSub: fit(90),
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
/** ~5 minutes. A tight, good 5-minute script beats a padded 8-minute one; the writer still aims
 *  for 8-10 via the role table, but a shorter script that is GOOD is no longer thrown away. */
export const MIN_WORDS = 750;
export type Script = z.infer<typeof ScriptSchema>;

export const VERIFY_CATEGORIES = ["factual", "misinformation", "misleading_metadata", "advertiser_friendly",
  "inauthentic_risk", "quality", "tone"] as const;
/** Only these can stop a script. Tone and quality are judged by the comedy pass and the forecast. */
export const BLOCKING_CATEGORIES = new Set(["factual", "misinformation", "misleading_metadata", "advertiser_friendly"]);

export const VerifySchema = z.object({
  verdict: z.enum(["pass", "revise", "abandon"]),
  adSuitability: z.enum(["likely_full", "likely_limited", "unsuitable"]),
  issues: z.array(z.object({
    // Models send ids as "sc3", 3 or null. All fine; normalise rather than reject.
    sceneId: z.union([z.string(), z.number()]).nullable().transform((x) => (x === null ? null : String(x))),
    // The prompt once asked for "tone" issues the enum did not contain, so nearly every judge
    // answer failed validation and was retried. Unknown categories now map to "quality".
    category: z.preprocess(
      (c) => (typeof c === "string" && VERIFY_CATEGORIES.includes(c as never) ? c : "quality"),
      z.enum(VERIFY_CATEGORIES)),
    severity: z.preprocess((x) => (typeof x === "string" ? x.toLowerCase() : x), z.enum(["blocker", "major", "minor"])),
    problem: z.string(),
    fix: z.string(),
  })),
  summary: z.string(),
});
export type Verification = z.infer<typeof VerifySchema>;

export type SceneTiming = { sceneId: string; start: number; end: number; speechSec: number };
