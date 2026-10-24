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

FILTERED="${TMPFILE}.filtered"
cleanup_add() { trap "cleanup; rm -f '$FILTERED'" EXIT; }
cleanup_add

echo "[1/4] exporting cookies from $BROWSER..."
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

RAW_BYTES=$(wc -c <"$TMPFILE" | tr -d ' ')
echo "[2/4] filtering to youtube.com domains only (raw: $RAW_BYTES bytes)..."
# Netscape cookies.txt: comment lines start with # (keep headers), data lines start with the domain.
# Keep: comment/header lines, youtube.com, .youtube.com, google.com (OAuth), .google.com.
# Drop every other site — GitHub secrets have a 48 KB limit, and shipping all your other sites'
# cookies would both bust the limit AND leak unrelated login state.
awk '
  /^#/ { print; next }
  /^$/ { print; next }
  $1 ~ /^\.?(youtube\.com|google\.com)$/ { print }
' "$TMPFILE" > "$FILTERED"

FILT_BYTES=$(wc -c <"$FILTERED" | tr -d ' ')
echo "        filtered: $FILT_BYTES bytes"
if [[ "$FILT_BYTES" -lt 500 ]]; then
  echo "✗ filtered cookies look empty. Is $BROWSER actually logged in to YouTube?" >&2
  exit 1
fi

echo "[3/4] base64-encoding..."
ENCODED="$(base64 -i "$FILTERED" | tr -d '\n')"
B64_BYTES=${#ENCODED}
echo "        encoded: $B64_BYTES chars (GitHub secret limit: 49152)"
if [[ "$B64_BYTES" -gt 48000 ]]; then
  echo "✗ encoded value too large for a GitHub secret. Open an issue — need to split or compress." >&2
  exit 1
fi

echo "[4/4] uploading as GH secret YT_COOKIES_B64..."
printf '%s' "$ENCODED" | gh secret set YT_COOKIES_B64 --body -
STATUS=$?

if [[ "$STATUS" -eq 0 ]]; then
  echo
  echo "✓ YT_COOKIES_B64 is live. Trigger the workflow:"
  echo "    gh workflow run clip.yml -f url=\"<youtube-url>\""
  echo
  echo "Note: that secret contains your YouTube session. If you suspect it leaked, log out of"
  echo "youtube.com on the originating device to invalidate it, then re-run this script."
fi
exit $STATUS
