/**
 * Phase-1 smoke test for the vendored Remotion composer.
 *
 * Renders the zero-key `world-in-numbers` demo (which uses only Remotion built-ins, no network media)
 * and asserts the resulting mp4 exists and is a plausible size. If this passes, the composer runs end
 * to end in this environment and Phase 2 can safely wire it into produce.ts; if it fails, nothing in
 * the pipeline is at risk because this is a standalone script.
 *
 * Usage: `npm run renderer:install && npm run renderer:smoke`
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const COMPOSER_DIR = path.join(process.cwd(), "remotion-composer");
const OUT_DIR = path.join(process.cwd(), "work", "renderer-smoke");
const OUT_FILE = path.join(OUT_DIR, "demo.mp4");
const PROPS_PATH = "public/demo-props/world-in-numbers.json"; // resolved from COMPOSER_DIR

function die(msg: string): never {
  console.error(`✗ renderer smoke test failed: ${msg}`);
  process.exit(1);
}

if (!existsSync(COMPOSER_DIR)) die(`${COMPOSER_DIR} missing — did you run \`cp\` on the vendored dir?`);
if (!existsSync(path.join(COMPOSER_DIR, "node_modules"))) {
  die(`${COMPOSER_DIR}/node_modules missing — run \`npm run renderer:install\` first.`);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log("→ rendering Explainer composition with world-in-numbers demo props...");
const started = Date.now();
const r = spawnSync(
  "npx",
  [
    "remotion", "render", "src/index.tsx", "Explainer", OUT_FILE,
    "--props", PROPS_PATH, "--codec", "h264",
    // Smoke test should be quick; the demo is ~22s @ 30fps. Rendering at --concurrency=1 is slower
    // but has predictable memory and avoids tripping sandboxes on dev machines. CI can override.
    "--concurrency", process.env.REMOTION_CONCURRENCY ?? "1",
    // Keep logs quiet so a passing run is a one-liner. Failures still print Chromium errors.
    "--log=error",
  ],
  { cwd: COMPOSER_DIR, stdio: "inherit" },
);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (r.status !== 0) die(`remotion render exited with status ${r.status} after ${elapsed}s`);
if (!existsSync(OUT_FILE)) die(`render reported success but ${OUT_FILE} does not exist`);
const bytes = statSync(OUT_FILE).size;
// A 22s 1080p h264 clip comes in around 1–5 MB; <100 KB means a header-only file.
if (bytes < 100_000) die(`${OUT_FILE} is ${bytes}B — looks truncated (expected > 100 KB)`);

console.log(`✓ renderer smoke test passed in ${elapsed}s — ${OUT_FILE} (${(bytes / 1_000_000).toFixed(2)} MB)`);
