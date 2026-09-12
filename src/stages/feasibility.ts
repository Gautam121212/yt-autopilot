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
import { probeQuery } from "../lib/sources";
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

async function scoreScenes(scenes: Scene[]) {
  return mapLimit(scenes, 4, async (s) => {
    const probes = await Promise.all([s.imageQuery, ...(s.altQueries ?? [])].map((q) => probeQuery(q, s.era)));
    const best = probes.reduce((a, b) => (b.score > a.score ? b : a), { score: 0, best: "" });
    return { scene: s, score: best.score, best: best.best };
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
    if (!weak.length || round === (o.rounds ?? 1)) break;

    const fixed = await askJson({
      tier: "light",
      schema: RewriteSchema,
      system: `You rewrite image searches for a documentary channel. A search has come back with nothing relevant,
which means the picture would end up unrelated to the narration — the single worst failure this channel has.

Rewrite each listed scene's imageQuery and altQueries so they name things a public photo archive genuinely holds:
a named place, a named object type, a building, a vehicle, a tool, a document, a map, a painting of the subject.
Avoid: magnified textures, people or crowds, brand-name products, abstractions, and invented compound nouns.
For historical scenes prefer what archives actually file: engravings, lithographs, period photographs, museum objects.
Keep the narration's meaning; only the searches change.`,
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
