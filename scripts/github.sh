#!/usr/bin/env bash
# `npm run github` - private repo + push + secrets + labels + permissions. Safe to re-run.
set -euo pipefail
REPO_NAME="${REPO_NAME:-yt-autopilot}"
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https
[ -d .git ] || git init -q -b main
git check-ignore -q .env || { echo "❌ .env is not gitignored - refusing to continue"; exit 1; }
git add -A
git -c user.name="${GIT_NAME:-yt-autopilot}" -c user.email="${GIT_EMAIL:-yt-autopilot@users.noreply.github.com}" commit -qm "yt-autopilot update" || true
if git remote get-url origin >/dev/null 2>&1; then git push -q -u origin HEAD; else gh repo create "$REPO_NAME" --private --source=. --push; fi
grep -E '^[A-Z_]+=.+' .env > .env.secrets
gh secret set -f .env.secrets
rm -f .env.secrets
gh label create approve --color 0E8A16 --description "publish this video" --force >/dev/null
gh label create reject --color B60205 --description "do not publish" --force >/dev/null
gh api -X PUT "repos/{owner}/{repo}/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true >/dev/null
echo "✅ GitHub ready: $(gh repo view --json url -q .url)"
echo "Next: npm run video:cloud"
