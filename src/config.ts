import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const WORK = path.join(ROOT, "work");

const SubNiche = z.object({
  id: z.string(),
  label: z.string(),
  weight: z.number().positive(),
  adRisk: z.enum(["low", "medium", "high"]),
  examples: z.array(z.string()).default([]),
  searchQueries: z.array(z.string()).min(1),
});

const Channel = z.object({
  channelName: z.string(),
  language: z.string(),
  audienceTimezone: z.string(),
  targetMinutes: z.tuple([z.number(), z.number()]),
  wordsPerMinute: z.number(),
  maxVideosPerWeek: z.number().int().positive(),
  /** Shorts published per week; they come from DIFFERENT videos than that week's long uploads. */
  shortsPerWeek: z.number().int().min(0).default(2),
  /** How many finished videos to keep queued so a bad week never means an empty channel. */
  backlogTarget: z.number().int().min(0).default(4),
  /** Successes wanted per day. The cron runs every few hours and stops once this is met. */
  videosPerDay: z.number().int().min(1).default(1),
  /** Whose day. UTC boundaries made "today" roll over at 05:30 IST; this fixes it. */
  productionTimezone: z.string().default("Asia/Kolkata"),
  maxAwaitingApproval: z.number().int().positive(),
  approval: z.object({
    mode: z.enum(["claude", "human"]).describe("claude = Claude's final check publishes on your behalf; human = you approve every video"),
    humanReviewFirst: z.number().int().min(0).describe("even in claude mode, send the first N videos to you"),
    minScore: z.number().min(0).max(10),
    /** A script must be forecast at least this well before any pixel is rendered. Rendering a 6/10
     *  script can only ever produce a 6/10 video, so the cheapest place to enforce quality is here. */
    minScriptScore: z.number().min(0).max(10).default(7.5),
    /** false = a held video is never uploaded; its review notes go to the learning loop instead. */
    uploadHeldVideos: z.boolean().default(false),
  }),
  categoryId: z.string(),
  subNiches: z.array(SubNiche).min(1),
  structures: z.array(z.object({ id: z.string(), description: z.string() })).min(2),
  niche: z.string(),
  voice: z.object({ provider: z.enum(["kokoro", "system", "elevenlabs", "openai"]), voiceId: z.string(), model: z.string(), speed: z.number().default(1) }),
  // NASA is gone as a visual source: its library is space-only, so it returned wrong pictures for
  // everything else and dragged whole videos down. It stays a research source, not a visual one.
  imageSources: z.array(z.enum(["pexels", "pixabay", "commons", "openverse"])).min(1),
  /** Fraction of scenes that may use a moving stock clip instead of a still (needs PEXELS_API_KEY). */
  videoClipRatio: z.number().min(0).max(1).default(0),
  fallbackImageQueries: z.array(z.string()).min(3),
  makeShorts: z.boolean(),
  discovery: z.object({ lookbackDays: z.number(), queriesPerRun: z.number().int().min(1), minViews: z.number() }),
  publish: z.object({
    candidateSlots: z.array(z.object({ dow: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23) })).min(1),
    epsilon: z.number().min(0).max(1),
    minSamplesPerSlot: z.number().int().min(1),
    minHoursAhead: z.number(),
    minGapHours: z.number(),
    /** true = the queue opens a "publish today" issue instead of scheduling via the API. */
    manual: z.boolean().default(false),
  }),
  learning: z.object({
    minVideosForLearning: z.number().int(),
    maxWeightChangePerCycle: z.number(),
    /** Ceiling the learning job may never raise cadence past, no matter how well things go. */
    cadenceCeiling: z.number().int().min(1).max(7).default(4),
    /** Sub-niches the learning job may add on its own before it must stop expanding. */
    maxLearnedSubNiches: z.number().int().min(0).default(8),
    /** true = the weekly job commits straight to main; false = it opens a pull request for you. */
    autoApply: z.boolean().default(false),
  }),
});

export type ChannelConfig = z.infer<typeof Channel>;
export type SubNicheT = z.infer<typeof SubNiche>;
export type Slot = ChannelConfig["publish"]["candidateSlots"][number];

export type Learned = {
  subNicheWeights?: Record<string, number>;
  maxVideosPerWeek?: number;
  addedSubNiches?: SubNicheT[];
  retiredSubNiches?: string[];
  updatedAt?: string;
};

export const learnedPath = () => path.join(ROOT, "config/learned.json");

export function loadLearned(): Learned {
  try { return JSON.parse(fs.readFileSync(learnedPath(), "utf8")) as Learned; } catch { return {}; }
}

/**
 * channel.json is yours; learned.json is what the weekly job is allowed to change.
 * Everything it writes is clamped here as well, so a bad write can never run away.
 */
export function loadChannel(): ChannelConfig {
  const cfg = Channel.parse(JSON.parse(fs.readFileSync(path.join(ROOT, "config/channel.json"), "utf8")));
  const learned = loadLearned();

  for (const extra of (learned.addedSubNiches ?? []).slice(0, cfg.learning.maxLearnedSubNiches)) {
    const parsed = SubNiche.safeParse(extra);
    if (parsed.success && !cfg.subNiches.some((s) => s.id === parsed.data.id)) cfg.subNiches.push(parsed.data);
  }
  const retired = new Set(learned.retiredSubNiches ?? []);
  const kept = cfg.subNiches.filter((s) => !retired.has(s.id));
  if (kept.length >= 4) cfg.subNiches = kept; // never let it shrink the channel to a single topic

  for (const s of cfg.subNiches) {
    const w = learned.subNicheWeights?.[s.id];
    if (typeof w === "number" && w > 0) s.weight = Math.min(3, Math.max(0.3, w));
  }
  if (typeof learned.maxVideosPerWeek === "number") {
    cfg.maxVideosPerWeek = Math.min(cfg.learning.cadenceCeiling, Math.max(1, Math.round(learned.maxVideosPerWeek)));
  }
  return cfg;
}

export const loadPlaybook = () => fs.readFileSync(path.join(ROOT, "config/playbook.md"), "utf8");

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const isDryRun = () => process.env.DRY_RUN === "true";
