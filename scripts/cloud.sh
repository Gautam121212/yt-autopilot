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
  # "Succeeded" only means the process exited cleanly. A run that abandons at a gate, or produces a
  # video the final check holds, also exits 0 — so ask the database what actually happened.
  npx tsx --env-file-if-exists=.env -e '
  import("./src/lib/db").then(async m => {
    const [v] = await m.q(
      "select id, title, status, actual_score, youtube_id from videos order by id desc limit 1");
    if (!v) { console.log("No video rows — the run stopped before creating one."); }
    else if (v.youtube_id) {
      console.log(`✅ #${v.id} "${v.title}" uploaded (private) — ${v.status}, scored ${v.actual_score ?? "n/a"}`);
      console.log(`   https://studio.youtube.com/video/${v.youtube_id}/edit`);
    } else {
      console.log(`⚠️  #${v.id} "${v.title}" was NOT uploaded — status ${v.status}${v.actual_score ? `, scored ${v.actual_score}` : ""}`);
      console.log("   Reasons: npm run why      Review queue: gh issue list");
    }
    await m.closeDb();
  });'
fi
