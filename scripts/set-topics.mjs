/**
 * node scripts/set-topics.mjs
 *
 * The channel's identity lives here, and it is FREE to change — no model, no render, just this list.
 * Edit TOPICS below, run this file, then `npm run github`. Each sub-niche is one lane the topic
 * picker draws from; searchQueries are what it looks up on YouTube to find what's already popular.
 *
 * Rules the picker relies on (keep to them or topics degrade):
 *  - id: lowercase_with_underscores, unique.
 *  - description: one line — the KIND of story, not an example. "Machines that failed in ways nobody
 *    predicted", not "the Tacoma bridge".
 *  - searchQueries: 3 phrases a viewer might actually search. These seed the demand signal.
 *  - Every lane must be FILMABLE from stock footage. "Bureaucratic absurdity" works (offices, forms,
 *    stamps); "famous chess games" does not (no stock footage of specific 1972 moves).
 *  - 8-16 lanes is the sweet spot. Fewer repeats itself; more dilutes the channel's identity.
 */
import fs from "node:fs";

const n = (id, description, searchQueries) => ({ id, label: id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), description, weight: 1, adRisk: "low", searchQueries });

// ── EDIT FROM HERE ──────────────────────────────────────────────────────────────────────────
const TOPICS = [
  n("reckless_science", "Researchers who experimented on themselves or their friends and somehow published", ["self experiment scientist", "scientist tested on himself", "dangerous experiment history"]),
  n("engineering_failures", "Structures, machines and vehicles that failed in ways nobody thought to prevent", ["engineering disaster explained", "why bridge failed", "design flaw collapse"]),
  n("bureaucratic_absurdity", "Serious institutions solemnly regulating something ridiculous, and the paperwork that followed", ["strange law reason", "weird regulation history", "bureaucracy absurd rule"]),
  n("animal_behaviour", "Animals doing things that look like a bug in the system, and the biology behind it", ["animal strange behaviour explained", "weird animal adaptation", "animal does impossible thing"]),
  n("body_weirdness", "Parts of the human body that behave like a design mistake", ["human body design flaw", "weird thing your body does", "anatomy strange fact"]),
  n("everyday_origins", "Ordinary objects and rules with a stupid, specific, documented reason behind them", ["why everyday object designed", "origin of common thing", "reason behind everyday rule"]),
  n("measurement_units", "Units and standards defined by something absurd, and what broke before them", ["how unit was defined", "weird measurement standard", "calibration history"]),
  n("lost_and_found", "Things misplaced at enormous scale — cargo, islands, spacecraft — and how they turned up", ["cargo lost at sea", "island that did not exist", "lost spacecraft found"]),
  n("space_mishaps", "Spaceflight and astronomy where the plan met reality and reality won", ["space mission went wrong", "space program mistake", "satellite failure story"]),
  n("food_chemistry", "Why food does what it does, including the accidents that created staples", ["food invented by accident", "food chemistry explained", "why food behaves"]),
  n("materials_gone_wrong", "Substances that seemed brilliant and turned out to be a problem, or the reverse", ["material seemed great turned bad", "invention had side effect", "chemical history mistake"]),
  n("early_medicine", "Treatments that were standard practice and should never have been", ["historical medical treatment strange", "old medicine history", "old cure that worked"]),
  n("infrastructure_hidden", "The unglamorous systems holding cities up, and what happens when one stops", ["hidden city infrastructure", "what happens when system fails", "underground city system"]),
  n("competition_gone_odd", "Contests and records won by exploiting a rule nobody had closed", ["sport rule loophole", "record broken loophole", "competition exploited rule"]),
];
// ── TO HERE ─────────────────────────────────────────────────────────────────────────────────

const ids = TOPICS.map((t) => t.id);
const dup = ids.find((id, i) => ids.indexOf(id) !== i);
if (dup) throw new Error(`duplicate id: ${dup}`);
for (const t of TOPICS) {
  if (!/^[a-z][a-z0-9_]*$/.test(t.id)) throw new Error(`bad id "${t.id}" — lowercase_with_underscores`);
  if (t.searchQueries.length < 2) throw new Error(`${t.id}: needs at least 2 searchQueries`);
}
const path = "config/channel.json";
const c = JSON.parse(fs.readFileSync(path, "utf8"));
const before = c.subNiches.length;
c.subNiches = TOPICS;
c.learning.maxLearnedSubNiches = Math.max(c.learning.maxLearnedSubNiches ?? 8, TOPICS.length);
fs.writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
console.log(`sub-niches: ${before} -> ${TOPICS.length}`);
console.log(TOPICS.map((t) => `  ${t.id.padEnd(24)} ${t.description.slice(0, 56)}`).join("\n"));
console.log("\nNext: git handled by `npm run github`. The next run picks from the new list.");
