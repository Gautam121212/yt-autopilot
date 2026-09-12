#!/usr/bin/env bash
# `npm run video:local` — the ONLY command that uses your Mac's CPU. Everything else runs on GitHub.
set -euo pipefail
cat <<'WARN'
This renders a full video ON THIS MAC: ~20-30 minutes of heavy CPU (voice + ffmpeg).
Your fans will spin up. Nothing is uploaded.

  Prefer:  npm run video:cloud   (same dry run, on GitHub's machine, video downloaded to you)

WARN
read -r -p "Run locally anyway? [y/N] " a
[[ "$a" =~ ^[Yy]$ ]] || { echo "Cancelled. Try: npm run video:cloud"; exit 0; }
echo "Running in low-power mode (ffmpeg limited to 2 threads, no parallel scene encoding)."
DRY_RUN=true LOW_POWER=true tsx --env-file-if-exists=.env src/jobs/produce.ts
shopt -s nullglob
files=(work/*/final*.mp4 work/*/short*.mp4)
[ ${#files[@]} -gt 0 ] && open "${files[@]}" || echo "No video produced — see the log above, then: npm run why"
