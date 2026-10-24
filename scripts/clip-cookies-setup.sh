#!/usr/bin/env bash
#
# One-shot: export YouTube cookies from the user's local Chrome, base64-encode, store as a
# GitHub Actions secret (YT_COOKIES_B64), and shred the temp file. Needed when YouTube bot-checks
# the GH runner IP (which is almost always, as of 2026 for datacenter IPs).
#
# Prerequisite: `gh auth login` first (so `gh secret set` has credentials).
#
# Usage:
#   bash scripts/clip-cookies-setup.sh                 # uses Chrome by default
#   bash scripts/clip-cookies-setup.sh firefox         # or safari / brave / edge / vivaldi

set -euo pipefail

BROWSER="${1:-chrome}"
TMPFILE="$(mktemp -t yt-cookies).txt"

cleanup() {
  if [[ -f "$TMPFILE" ]]; then
    # Overwrite before unlink so a casual recovery doesn't dig it back out.
    dd if=/dev/urandom of="$TMPFILE" bs=4096 count=1 conv=notrunc 2>/dev/null || true
    rm -f "$TMPFILE"
  fi
}
trap cleanup EXIT

echo "[1/3] exporting cookies from $BROWSER..."
# A one-off yt-dlp call to a trivial YouTube URL is the cleanest way to coax it into writing a
# cookies.txt — we're not downloading anything, just letting the cookies plumbing run.
yt-dlp \
  --cookies-from-browser "$BROWSER" \
  --cookies "$TMPFILE" \
  --skip-download \
  --quiet \
  "https://www.youtube.com/" >/dev/null 2>&1 || true

if [[ ! -s "$TMPFILE" ]]; then
  echo "✗ cookies file is empty. Is $BROWSER logged in to YouTube? Try: $0 safari / firefox / brave" >&2
  exit 1
fi

echo "[2/3] base64-encoding ($(wc -c <"$TMPFILE") bytes)..."
ENCODED="$(base64 -i "$TMPFILE" | tr -d '\n')"

echo "[3/3] uploading as GH secret YT_COOKIES_B64..."
echo -n "$ENCODED" | gh secret set YT_COOKIES_B64 --body -

echo
echo "✓ YT_COOKIES_B64 is now live in GitHub Actions. Trigger the workflow:"
echo "    gh workflow run clip.yml -f url=\"<youtube-url>\""
echo
echo "Note: that secret contains your YouTube SESSION. If you suspect it leaked, log out of"
echo "youtube.com on the originating device to invalidate it, then re-run this script."
