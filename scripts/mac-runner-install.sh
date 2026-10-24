#!/usr/bin/env bash
#
# One-time setup: register this Mac as a self-hosted GitHub Actions runner for the clip-pipeline
# workflow's download step. The runner only picks up jobs with `runs-on: [self-hosted, mac-downloader]`,
# so it will NEVER run any other workflow — this Mac is strictly a download worker.
#
# Why: YouTube bot-checks GitHub-hosted datacenter IPs. Your Mac's residential IP doesn't trip
# that. The runner wakes up only for the ~2-5min download step, then sits idle.
#
# Usage:
#   bash scripts/mac-runner-install.sh
#
# Prereqs:
#   - `gh auth login` done already (we fetch the runner token via the GH API)
#   - This Mac has yt-dlp + ffmpeg + Node 22 (brew installs below)

set -euo pipefail

REPO="Gautam121212/yt-autopilot"
RUNNER_DIR="${HOME}/actions-runner-yt-clipper"
RUNNER_NAME="mac-$(hostname -s | tr '[:upper:]' '[:lower:]')"
RUNNER_LABELS="self-hosted,mac-downloader"

echo "[1/6] prerequisites..."
command -v brew >/dev/null || { echo "✗ Homebrew missing. Install from https://brew.sh"; exit 1; }
brew list yt-dlp >/dev/null 2>&1 || brew install yt-dlp
brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
command -v node >/dev/null || brew install node@22
command -v gh >/dev/null || brew install gh

echo "[2/6] fetching one-time registration token for $REPO..."
TOKEN=$(gh api -X POST "repos/${REPO}/actions/runners/registration-token" -q .token)
if [[ -z "$TOKEN" ]]; then echo "✗ couldn't fetch token. Run 'gh auth login' first."; exit 1; fi

echo "[3/6] downloading runner tarball to $RUNNER_DIR..."
if [[ -d "$RUNNER_DIR" ]]; then
  echo "  (directory exists — remove it to re-install from scratch)"
else
  mkdir -p "$RUNNER_DIR"
  cd "$RUNNER_DIR"
  # Latest macOS ARM64 runner. Update LATEST line if GitHub bumps the version.
  LATEST="2.329.0"
  curl -sSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${LATEST}/actions-runner-osx-arm64-${LATEST}.tar.gz"
  tar xzf runner.tar.gz
  rm runner.tar.gz
fi

cd "$RUNNER_DIR"

echo "[4/6] configuring runner (name=$RUNNER_NAME, labels=$RUNNER_LABELS)..."
if [[ -f .runner ]]; then
  echo "  (already configured — skipping)"
else
  ./config.sh \
    --url "https://github.com/${REPO}" \
    --token "$TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS" \
    --unattended \
    --replace
fi

echo "[5/6] installing as a launchd service (survives reboots, auto-starts on login)..."
./svc.sh install || true
./svc.sh start || true

echo "[6/6] done. Runner status:"
./svc.sh status || true

cat <<EOF

✓ Mac runner installed. The runner listens for clip-pipeline jobs and does nothing else.

To check that GitHub sees it:
  gh api repos/${REPO}/actions/runners | python3 -c "import json,sys;d=json.load(sys.stdin);print('\n'.join(f'{r[\"name\"]:30}  {r[\"status\"]:10}  labels={[l[\"name\"] for l in r[\"labels\"]]}' for r in d['runners']))"

To stop / uninstall later:
  cd $RUNNER_DIR && ./svc.sh stop && ./svc.sh uninstall && ./config.sh remove

To trigger the pipeline (uses discovery when no URL):
  gh workflow run clip-pipeline.yml

EOF
