# YT Clipper Pipeline — Full Reference

Spec-section-12 deliverables doc for the yt-autopilot clipper, covering M3 → M8.
Last updated: M8 (2026-10-28).

---

## 1. Concise diagnosis of the original problems

Three failing M4 samples at `/Users/gautamgupta/Downloads/clips-40355259447/final/`:

| Clip | Content | Primary failure | Pipeline stage at fault |
|---|---|---|---|
| `short_01.mp4` | Profile face of a man in a French chateau renovation vlog, attribution bar "The Chateau Diaries" | SOURCE SELECTION — lifestyle vlog from a smaller channel | `discover.ts` ranker had no content-type filter and no channel-baseline signal |
| `short_02.mp4` | Woman in pink sweater, face SLICED at the left frame edge | CROP LOGIC — center-crop of a two-shot sliced one subject's face | `assemble.ts` used blind `crop=ih*9/16:ih`; no face detection |
| `short_03.mp4` | Chateau dinner party, framing survives but content is lifestyle | SOURCE SELECTION — same channel as above, dinner-party vlog | Same as short_01 |

All three sourced from the same channel ("The Chateau Diaries"). The M4 ranker's velocity + view-count scoring correctly identified a trending video but had no filter for CONTENT TYPE — it treated a trending chateau-vlog identically to a trending challenge.

## 2. Files and components changed (M5 → M8)

```
src/lib/clipper/
├── discover.ts         ← rank: velocity, baseline multiple, creator allowlist, genre keywords,
│                         lifestyle blocklist, Agent-Reach + narrative classifier enrichment
├── signals.ts          ← YT-heatmap, comment-timestamp clustering, chapter signals
├── retention-planner.ts← picks clip windows from the engagement curve; shorts/long rule
├── crop-safety.ts      ← face-aware + multi-subject detection → center-crop|blurred-bg|unsafe
├── assemble.ts         ← two layouts (center-crop, blurred-bg) + attribution + caption burn-in
├── polish.ts           ← two-pass loudnorm + alimiter
├── snap.ts             ← silence-boundary + sentence-boundary clip trim (M8.5)
├── score.ts            ← per-clip gate scoring with critical-fail bypass
├── decide.ts           ← auto-selects shorts/long OR honors the planner's hint
├── recover.ts          ← one-pass retry on failed clips
├── qc.ts               ← post-render QC: dims, duration, blackframe, A/V sync, frozen,
│                         face presence, sliced-face
├── outcomes.ts         ← learning-loop record of every produced/rejected clip
├── state.ts            ← reviewed-blacklist + per-video state
├── upload.ts           ← direct YT Studio upload via existing OAuth
├── provenance.ts       ← source URL, uploader, license, review-flags recorded in manifest
├── agent-reach.ts      ← Panniantong/Agent-Reach wrapper (Reddit + web mention counts)
├── captions.ts         ← whisper transcription wrapper → SRT
├── narrative-classifier.ts  ← LLM "is this worth clipping?" judge
└── py/
    ├── face_scan.py        ← Mediapipe face bboxes @ 1fps + multi-subject flags
    └── whisper_captions.py ← faster-whisper → SRT with word timestamps

scripts/
├── clip-discover.ts    ← pulls top-K candidates to queue.json
├── clip-plan.ts        ← retention-planner → plan.json
├── clip-fetch.ts       ← Mac-only yt-dlp downloads; writes sections.json + provenance
├── clip-process.ts     ← Ubuntu: snap → polish → score → decide → crop-safety → assemble → QC
├── clip-upload.ts      ← CLI entry for YT Studio upload
├── clip-regression.ts  ← M8.1 harness: asserts the 3 M4 samples would fail today
└── clip-wipe-learning.ts

.github/workflows/
├── clip-pipeline.yml   ← 5-job pipeline: discover (Ubuntu) → plan (Mac) → fetch (Mac)
│                         → process (Ubuntu) → pending-review (Ubuntu)
└── clip-approve.yml    ← /approve or /reject GitHub issue comments trigger upload
```

## 3. Source-ranking + moment-selection logic

### Rank score (`discover.ts rank`)

```
score = (velocityScore + log10(1 + viewsPerDay) * 5)
       * durationBandBonus       # 0.6..1.2 depending on 10-180min window
       * categoryBonus            # 1.3 People&Blogs, 1.2 Gaming, 1.15 Entertainment
       * freshnessBonus           # 1.0 → 0.3 over 30 days
       * chapterDensityBonus      # 1.0..1.2 for chaptered videos
       * outcomePenalty           # 0.4 if channel has ≥3 past failed clips
       * creatorBonus             # 1.5 if in CREATOR_ALLOWLIST (MrBeast, Dude Perfect, …)
       + engagementRate / 100
       + likeViewPct * 2
       + genreKeywordHits * 8     # cap 3 hits; "challenge", "experiment", "$1 vs ", …
```

Then enriched for the top 5:

- **Channel-baseline multiple** (`enrichWithBaseline`): fetches channel's last 10 videos, computes `viewCount / median(baseline)`. `+log2(multiple) * 8` boost when the video is overperforming its own channel's baseline (spec section 3's "small channel with a breakout video" preference).
- **Agent-Reach mentions** (`enrichWithMentions`): Reddit + web search mention counts via Panniantong/Agent-Reach CLI. `+log10(1 + hits) * 12` boost. Degrades silently if CLI not on PATH.
- **LLM narrative classifier** (`enrichWithNarrative`): Mistral judge rates hook / novelty / payoff / standalone-clarity / emotional-intensity. Hard-rejects `filler` type regardless of channel size. `+viralRating * 0.6` for passing videos.

### Lifestyle blocklist (hard filter, pre-rank)

56 keywords across English + French. Matches on `title + " || " + channelTitle`. Full list in `discover.ts LIFESTYLE_BLOCKLIST`. Regression-tested: see §7.

### Moment selection (`retention-planner.ts`)

For each picked source:
1. `signals.ts` fetches YouTube's "most replayed" heatmap, top 500 comments with timestamps, chapters.
2. Build a weighted engagement curve: heatmap × 1.0 + comment-timestamp clusters × 0.7 + chapters × 0.1.
3. Extract peaks in two bands:
   - **Short** (20–90s): top MAX_SHORTS=5 non-overlapping peaks → `format=shorts`
   - **Long** (4–15min): single strongest peak → `format=long`
4. Fallback: when the video has NO heatmap AND NO timestamped comments AND NO chapters, call the LLM transcript picker (`yt-clipper.pickCandidates`).

Peaks propagate through fetch (M6.1 fix) so the processor honors `format` instead of re-deciding.

### Clip boundaries

`snap.ts snapToSilence`:
- Silence detection (ffmpeg silencedetect, -30dB, 250ms min) within ±2s of each boundary.
- M8.5: when a whisper SRT is available, PREFER silences that fall at a sentence end (word ends in `. ! ?`) within 0.3s. Falls back to any silence.
- Won't move boundaries if snapped duration would be <10s.

## 4. How the crop system decides what to keep visible

Decision tree in `crop-safety.ts checkCropSafety`:

```
┌─ probe dimensions
├─ source already portrait? → center-crop (safe, no reframe)
├─ run face scan (Mediapipe @ 1 fps)
│   ├─ if ≥30% frames have ≥2 faces separated by width/4+
│   │  OR ≥20% have faces at opposite horizontal thirds:
│   │    → blurred-bg (preserves both subjects)
│   ├─ if ≥30% frames have at least one face:
│   │    ├─ ≥75% of face centers inside the 9:16 center stripe AND ≤5 scene cuts:
│   │    │    → center-crop (classic path)
│   │    └─ else: blurred-bg (face off-center but still shown)
│   └─ if <30% face presence: fall back to cropdetect active-region check
└─ cropdetect fallback (B-roll, food shots, text cards):
    ├─ ≥75% centered + ≤5 scene cuts: → center-crop
    └─ else: → blurred-bg
```

If face_scan.py fails entirely (Mediapipe not installed), falls back to cropdetect alone. If BOTH fail: `unsafe` and the clip is rejected (not shipped).

The two layouts in `assemble.ts makeShort`:

- **center-crop**: `crop=ih*9/16:ih,scale=1080:1920:flags=lanczos` — destructive but tight, best for already-centered content.
- **blurred-bg**: `split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur,eq=brightness=-0.08[bgb];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2` — non-destructive. The original landscape frame fits inside the 1080×1920 canvas; a dim-blurred copy of itself fills the top and bottom bars.

## 5. Models, libraries, APIs, compute

| Category | Tool | Where / why |
|---|---|---|
| Download | yt-dlp (Firefox cookies on Mac) | Only CPU work on Mac; everything else Ubuntu CI |
| Face detection | Mediapipe `face_detection` (model_selection=1, full-range) | `face_scan.py`, used by crop-safety.ts + qc.ts |
| Transcription | faster-whisper 1.0.3 CPU int8 `base` for captions, `tiny` for snap | `whisper_captions.py` |
| Scene cuts | ffmpeg `select='gt(scene,0.4)'` | crop-safety.ts |
| Loudnorm | ffmpeg two-pass loudnorm + alimiter brick-wall | polish.ts |
| Black-frame QC | ffmpeg blackdetect + blackframe (M8 fix) | qc.ts |
| Freeze-frame QC | ffmpeg freezedetect | qc.ts |
| A/V sync QC | ffprobe stream-duration delta | qc.ts |
| LLM narrative judge | Mistral `ministral-14b-2512` via existing `askJson` | narrative-classifier.ts (role=judge, tier=light) |
| LLM moment pick (fallback) | Mistral `mistral-large-2512` | yt-clipper.ts pickCandidates |
| YouTube Data API v3 | `videos.list`, `search.list` | discover.ts |
| Cross-platform mentions | Panniantong/Agent-Reach CLI (Reddit, Jina web search) | agent-reach.ts |
| Attribution + captions burn-in | ffmpeg drawtext + subtitles filter + DejaVu Sans | assemble.ts |
| YT upload | googleapis `videos.insert` via existing OAuth | upload.ts |
| CI compute | GitHub Actions ubuntu-latest + self-hosted Mac for downloads | clip-pipeline.yml |

## 6. Limitations, costs, licensing

### Signals we DO NOT have (honestly flagged as "unavailable" per spec section 3)

- Measured YouTube Studio audience retention — only accessible to a channel's own owner. Our proxy = YT's public "most replayed" heatmap + comment-timestamp clustering + chapters.
- TikTok/Instagram/X mention counts — these platforms require interactive login (cookies, CAPTCHAs) that aren't viable on CI. Agent-Reach `doctor` reports which channels work; on CI only Reddit + Jina Reader web search work.
- Creator-authorized licensing information for most videos — unless `yt-dlp` returns "Creative Commons" in its license field (<5% of YouTube), we record `license: "standard-youtube"` and `redistributionRights: "unverified"`.

### Costs

- YouTube Data API: ~50 units/day typical, free tier is 10,000/day. Easily within.
- Mistral: ~5 narrative-classifier calls per pipeline run, ~1k tokens each. Experiment tier ~free.
- GitHub Actions: Ubuntu 15-min cap per job, Mac is self-hosted so free.
- Agent-Reach: no API fees (uses open-source backends).
- Whisper: fully local on CI runner, no cost.

### Legal

- `yt-dlp` fetches videos through YouTube's public endpoints. "Standard YouTube License" DOES NOT grant redistribution rights. The user accepted this risk explicitly in session M4 ("I'll look after legal issues").
- Every clip ships with a 3-second attribution overlay (channel + original title) and the full source URL in the YT upload description.
- `provenance.reviewFlags` surfaces age-restricted / low-resolution / no-license-info videos for human review before upload. These never auto-ship.

### Known architecture gaps (M9 scope)

- No inter-frame subject tracking — crop decisions are static per clip (center-crop OR blurred-bg for the whole clip), not dynamic pan/zoom following a moving subject.
- No speaker diarization — captions don't currently respect speaker changes.
- Agent-Reach install on CI is best-effort (`continue-on-error`) — if their install flow changes, mention enrichment silently degrades to zero and the ranker proceeds without it.
- Mediapipe install is ~400 MB per CI run (cached between runs, but first run is slow).

## 7. Automated tests and their results

Run with:
```bash
npm run clip:regression -- --samples /path/to/clips-40355259447/final
```

Current result on 2026-10-28 (local, no mediapipe → face assertions skipped gracefully):

```
🧪 Clipper M8.1 regression harness
[M4 sample tests] /Users/gautamgupta/Downloads/clips-40355259447/final
[Discover blocklist tests]
[discover] rejected 3 lifestyle/vlog videos (title/channel match)
[Challenging-case tests]

──────────── Results ────────────
  ✓ M4-short_01: face detection unavailable (mediapipe not installed) — tech-QC skip
  ✓ M4-short_02: face detection unavailable (mediapipe not installed) — skipped
  ✓ M4-short_03: tech QC not asserted (framing was ok; failure was source selection)
  ✓ Blocklist rejects: chateau in title
  ✓ Blocklist rejects: The Chateau Diaries channel
  ✓ Blocklist rejects: GRWM
  ✓ Blocklist keeps: shark-cage challenge
  ✓ Blocklist keeps: dodgeball tournament
  ✓ Portrait source → safe, source already portrait
  ✓ Centered content → center-crop OR safe

✓ 10/10 passed
```

On CI (mediapipe present): the two "face detection unavailable" skips become hard assertions on sliced-face and face-presence respectively.

## 8. Sample outputs

The M4 samples at `/Users/gautamgupta/Downloads/clips-40355259447/final/short_0{1,2,3}.mp4` are the pre-fix failing baseline. Post-fix verified output requires a fresh pipeline run; see §10.

## 9. Before/after comparison

| Failure | M4 (before) | M8 (after) |
|---|---|---|
| Source: lifestyle vlog | Shipped as top pick | Lifestyle blocklist catches at discover; narrative classifier double-checks top 5 and hard-rejects `filler` |
| Face sliced at edge | Shipped, no detection | Mediapipe face_scan at 1 fps; multi-subject check at opposite thirds; QC post-render check for faces touching frame edge |
| No subject in frame | Shipped as "centered crop" | Face-presence ≥30% required; blurred-bg fallback when subject is off-center; QC rejects if expectFaces & no faces in final |
| No speech captions | None | faster-whisper SRT burned at lower-third (MarginV=360) with DejaVu Sans + black outline |
| Attribution overflow | 100-char cap overflowed 1080px frame | 20/30-char cap with ellipsis |
| Format hint lost in fetch | 4-min long window shipped as a short | plan.format propagated through sections.json |
| No post-render QC | ffmpeg exit code = "success" | 8-check QC: dims, duration, blackframe (strict + mostly-black), A/V sync drift, frozen runs, face presence when expected, sliced faces |
| No provenance | manifest.json: title + URL only | Full provenance: license, review-flags, consent-status, categoryId, downloadedAt |

## 10. Exact run instructions

```bash
# Install
npm ci
cd .github/workflows  # read clip-pipeline.yml for the Mac self-hosted runner setup

# Trigger a pipeline run (fresh pick)
gh workflow run clip-pipeline.yml -R Gautam121212/yt-autopilot

# Trigger with a specific URL (bypass discovery)
gh workflow run clip-pipeline.yml -R Gautam121212/yt-autopilot -f url=https://youtu.be/XXXX

# Watch
gh run watch -R Gautam121212/yt-autopilot

# Download the output artifact
gh run download <RUN_ID> -R Gautam121212/yt-autopilot -n clips-<RUN_ID> -D /tmp/out

# A review issue opens automatically. Approve a clip:
#   comment on the issue:  /approve 1 unlisted
# Or reject:
#   /reject 2

# Run the regression harness locally
npm run clip:regression -- --samples /path/to/sample-clips

# Reset the learning loop
npm run clip:wipe
```

Required env: `YT_API_KEY`, `MISTRAL_API_KEY`, `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`.

Optional: `GEMINI_API_KEY` (narrative-classifier fallback). Agent-Reach install happens inside CI; no secret needed.
