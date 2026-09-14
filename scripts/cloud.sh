#!/usr/bin/env bash
# `npm run video:cloud` (dry run, downloads the video)  |  `npm run video:live` (uploads to YouTube)
set -euo pipefail
MODE="${1:-dry}"
DRY=$([ "$MODE" = "live" ] && echo false || echo true)
gh workflow run produce -f dry_run="$DRY" -f force="${FORCE:-false}"
echo "Started. Waiting for GitHub to pick it up..."
sleep 8
RUN_ID=$(gh run list -w produce -L 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status || { echo "❌ Run failed. Logs: gh run view $RUN_ID --log-failed"; exit 1; }
if [ "$DRY" = "true" ]; then
  rm -rf downloads && gh run download "$RUN_ID" -D downloads
  echo "✅ Videos downloaded:"; find downloads -name "*.mp4"
  open $(find downloads -name "*.mp4") 2>/dev/null || true
else
  echo "✅ Uploaded. If Claude held it or it's one of your first videos:  gh issue list"
fi
