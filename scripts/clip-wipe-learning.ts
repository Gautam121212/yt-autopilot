/**
 * Clipper M5 — wipe learning data. Reset outcomes.json and reviewed.json so the loop starts
 * fresh with the new signal set (velocity, retention peaks, crop-safety). Previous data was
 * collected before these signals existed, so it would bias the ranker toward the wrong patterns.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const outcomes = path.join(ROOT, "data", "clipper", "outcomes.json");
  const reviewed = path.join(ROOT, "data", "clipper", "reviewed.json");
  await writeFile(outcomes, JSON.stringify({ version: 1, records: [] }, null, 2) + "\n");
  await writeFile(reviewed, JSON.stringify({ version: 1, records: {} }, null, 2) + "\n");
  console.log(`✓ wiped ${outcomes}`);
  console.log(`✓ wiped ${reviewed}`);
  console.log(`\nLearning starts over at the next pipeline run.`);
}

main().catch((e) => { console.error(`✗ wipe failed: ${(e as Error).message}`); process.exit(1); });
