/**
 * Checks every scene's image query against the archive BEFORE production, and rewrites the ones
 * nothing can satisfy. Metadata-only searches: seconds, no downloads, no model calls unless a
 * rewrite is actually needed. This is the cheapest place to stop a mismatched-picture video.
 */
import { z } from "zod";
import type { ChannelConfig } from "../config";
import { askJson } from "../lib/llm";
import { log } from "../lib/log";
import { mapLimit } from "../lib/media";
import { openverseImage, probeQuery } from "../lib/sources";
import type { Script } from "../types";

type Scene = { id: string; narration: string; imageQuery: string; altQueries: string[]; era: "historical" | "modern" | "any" };

const RewriteSchema = z.object({
  scenes: z.array(z.object({
    id: z.string(),
    imageQuery: z.string(),
    altQueries: z.array(z.string()).min(2).max(3),
  })),
});

const GOOD = 0.5;
/** Below this, production would be a slideshow of wrong pictures. Rewrite or drop the topic. */
export const MIN_FEASIBLE = Number(process.env.MIN_FEASIBLE ?? 0.6);

async function scoreScenes(scenes: Scene[]) {
  return mapLimit(scenes, 4, async (s) => {
    const probes = await Promise.all([s.imageQuery, ...(s.altQueries ?? [])].map((q) => probeQuery(q, s.era)));
    const best = probes.reduce((a, b) => (b.score > a.score ? b : a), { score: 0, best: "" });
    return { scene: s, score: best.score, best: best.best };
    // Note: the probe only checks Commons. Production also searches Openverse, Pexels and NASA,
    // so real coverage is higher than this number — the forecast is told so below.
  });
}

/** Returns the script with unusable queries rewritten, plus the share of scenes that now look findable. */
export async function ensureIllustratable(o: { cfg: ChannelConfig; script: Script; rounds?: number }): Promise<{ script: Script; feasible: number }> {
  let script = o.script;
  let feasible = 0;

  for (let round = 0; round <= (o.rounds ?? 1); round++) {
    const scenes = script.scenes as unknown as Scene[];
    const scored = await scoreScenes(scenes);
    const weak = scored.filter((r) => r.score < GOOD);
    feasible = +(1 - weak.length / scored.length).toFixed(2);
    log(`  image feasibility: ${Math.round(feasible * 100)}% of scenes have a findable picture${weak.length ? ` (${weak.length} weak)` : ""}`);
    if (!weak.length || round === (o.rounds ?? 3)) break;

    const fixed = await askJson({
      tier: "light",
      schema: RewriteSchema,
      system: `You rewrite image searches for a video whose footage comes from STOCK LIBRARIES (Pexels, Pixabay)
first and photo archives second. A search that returns nothing means the scene gets an unrelated picture, which is
the worst failure this channel has.

THE RULE: search for the GENERIC, FILMABLE thing, not the specific historical object.
Stock libraries hold: hands working, tools, machinery turning, welding sparks, steam, rust, water pouring, fire,
storm clouds, city streets, cranes, factory interiors, laboratory glassware, old paper and ledgers, coins, gears,
bricks, cables, train tracks, ships, harbours, mines, tunnels, scaffolding, blueprints, dust, ice, mud.
They do NOT hold: "1888 US Steamboat Inspection Service plaque", "Plimsoll line on SS Great Eastern",
"fusible plug patent drawing". Those return nothing.

So rewrite "1888 steamboat inspection mandate" as "old ledger stamp" or "steam boiler gauge"; rewrite
"Beaumont's gastric experiment jar" as "glass jar laboratory". Keep the narration's meaning; only the searches
change. Two or three DIFFERENT generic options per scene.`,
      prompt: `Scenes whose searches failed (with the best — and wrong — thing the archive returned):
${weak.map((w) => `- ${w.scene.id} (${w.scene.era}) query "${w.scene.imageQuery}" -> best match "${w.best || "nothing"}" (score ${w.score})\n  narration: ${w.scene.narration.slice(0, 200)}`).join("\n")}

JSON: { "scenes": [{ "id", "imageQuery", "altQueries": [2-3] }] }`,
    }).catch(() => null);
    if (!fixed) break;

    const byId = new Map(fixed.scenes.map((s) => [s.id, s]));
    script = {
      ...script,
      scenes: script.scenes.map((s) => {
        const f = byId.get(s.id);
        return f ? { ...s, imageQuery: f.imageQuery, altQueries: f.altQueries } : s;
      }),
    };
  }
  return { script, feasible };
}
