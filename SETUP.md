# Setup: every command, in order (macOS)

No paid subscription needed. The default provider is the **Gemini free tier**
(no credit card). You can switch to a Claude subscription or an Anthropic API key later
by re-running `npm run setup`.

## 1. Install tools  (Terminal)
```bash
xcode-select --install 2>/dev/null || true
command -v brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
[ -x /opt/homebrew/bin/brew ] && { grep -q 'brew shellenv' ~/.zprofile 2>/dev/null || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile; eval "$(/opt/homebrew/bin/brew shellenv)"; }
brew install node ffmpeg gh
node -v && ffmpeg -version | head -1 && gh --version | head -1
```
Expected: three version lines, node v22 or higher.

## 2. Project
```bash
cd ~/Downloads && unzip -o yt-autopilot.zip && cd yt-autopilot && npm install
```

## 3. Four free accounts (browser)
**A. AI key**: aistudio.google.com/apikey -> Create API key -> copy it. Do NOT enable billing on that project (billing deletes the free tier).

**B. YouTube channel**: youtube.com -> profile picture -> Create a channel. Then youtube.com/verify (phone).

**C. Database**: neon.tech -> Sign up -> Create project (any name, nearest region) -> Connect -> copy the connection string.

**D. Google Cloud**: console.cloud.google.com, signed in with the SAME Google account as the channel.
1. Top bar project picker -> New project -> name `yt-autopilot` -> Create -> select it.
2. Search bar: `YouTube Data API v3` -> Enable. Search bar: `YouTube Analytics API` -> Enable.
3. Search bar: `Google Auth Platform` -> Get started -> app name `yt-autopilot`, your email -> Audience: External -> Create.
4. Left menu Audience -> Publish app -> Confirm.
5. Left menu Clients -> Create client -> Application type: Web application -> Authorized redirect URIs -> Add URI `http://localhost:5858/callback` -> Create.
6. Keep that popup open: you need the Client ID and Client secret in step 5.

## 4. Connect everything
```bash
npm run setup
```
Choose option **1 (Gemini free tier)** when it asks. Then paste: Gemini key, Neon string, Client ID, Client secret, channel name.
Then it prints a Google link: open it, pick the channel's account. If Google says "hasn't verified this app": Advanced -> Go to yt-autopilot.
Expected last line: `✅ All checks passed.`

## 5. First video on your Mac (nothing is uploaded)
```bash
npm run video:local
```
20-40 minutes. Both videos open when done. The verdict is printed near the end (`final check: publish (8/10)`),
details in `work/1/review-pack.md`.

## 6. Put it on GitHub
```bash
npm run github
```
Expected: `✅ GitHub ready: https://github.com/<you>/yt-autopilot`

## 7. Test run on GitHub (nothing is uploaded, video downloads to your Mac)
```bash
npm run video:cloud
```

## 8. First real upload
```bash
npm run video:live
gh issue list
gh issue view <NUMBER>
gh issue edit <NUMBER> --add-label approve
```
Your first 3 videos come to you as issues. After that it publishes on its own when a video scores >= 7/10.
To reject: `gh issue comment <NUMBER> --body "reason"` then `gh issue edit <NUMBER> --add-label reject`.

## 9. Unlock public publishing (one form, takes weeks)
Open https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits -> "Audit and Quota Extension Form".
Until approved, uploads stay private: publish them in YouTube Studio at the time shown in the issue/log.

## After setup it runs itself
Mon & Thu: new video · daily: analytics · Sunday: playbook improvements proposed as a pull request.
```bash
gh run list                      # what ran
gh run view --log-failed         # why something failed
gh pr list                       # weekly improvement proposals
gh pr merge <NUMBER> --squash    # accept one
npm run github                   # after you change anything locally (config, .env)
```

## Switching provider later
```bash
npm run setup          # pick 2 (Claude Pro/Max) or 3 (Anthropic API key)
npm run github         # push the new secret
```
For option 2, install Claude Code first: `curl -fsSL https://claude.ai/install.sh | bash`, then `claude setup-token`.

## Backup provider (when Gemini is overloaded)

`npm run models` now saves a comma-separated chain, e.g. `GEMINI_MODEL_HEAVY=gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash`.
If the first model answers 503, the pipeline automatically tries the next one. Re-run `npm run models` any time to refresh the chain.

If Gemini as a whole is down or your daily quota is gone, switch providers:
```bash
npm run setup          # pick "Groq / OpenRouter / Cerebras / Mistral"
npm run check
npm run github         # push the new secrets
```
Choose a provider whose free limit is **per day**, not per minute of output. Measured the hard way:

| Provider | Works as a backup? |
|---|---|
| OpenRouter (`:free` models) | yes — per-day request limit, full-length scripts fine |
| Groq free tier | **no** — caps output at ~1000 tokens/minute and rejects a script request outright |
| Cerebras free | partial — small context, fine for topic/feasibility only |

```bash
# .env
OPENAI_COMPAT_BASE_URL=https://openrouter.ai/api/v1
OPENAI_COMPAT_API_KEY=...
# then let the provider name its own models:
npm run models:backup
```
`OPENAI_COMPAT_MAX_TOKENS` (default 4096) caps what the backup is asked to produce. If a provider rejects
requests as "too large", lower it — but a value below 4096 means the backup can only handle the light steps
(topic, feasibility), and script writing waits for Gemini's quota to reset.

## GitHub Actions minutes

Private repos on the Free plan get 2,000 Actions minutes a month, shared across every repo on the account.
Check what is left before you start:
```bash
gh api /users/{owner}/settings/billing/actions        # replace {owner} with your username
```
(If that endpoint 404s, use github.com -> Settings -> Billing -> Plans and usage.)

Rough cost of this pipeline: ~20-30 min per video (2 videos/week), ~1 min per analytics run (Mon/Wed/Fri),
~2 min for the weekly learning job. Call it **250-350 minutes a month**.

If your other projects already use most of the 2,000:
- **Make this repo public** — public repositories get unlimited free Actions minutes. The code contains no
  secrets (those live in encrypted repository secrets), so this is the cheapest fix.
  `gh repo edit --visibility public --accept-visibility-change-consequences`
- Or drop to one video a week: change the produce cron to `30 3 * * 1`.

## Changing how often it publishes

The produce workflow now runs **every day**, and `maxVideosPerWeek` in `config/channel.json` decides how many
actually get made. A run that hits the cap exits in seconds, so unused days cost almost no Actions minutes.

```bash
# edit config/channel.json -> "maxVideosPerWeek": 3
npm run github     # push the change
```

Minutes cost per extra video: about 25. Free-plan private repos have 2,000/month shared across your account.
Gemini free tier is the other ceiling: one video is roughly 12-18 model calls, well inside the daily limit at
3-4 videos a week, tighter above that.

## What the weekly learning job may change by itself

It runs Sundays, needs 8 videos with 7+ days of data, and may adjust:

| Thing | Limit enforced in code |
|---|---|
| Playbook writing rules | rewritten each cycle, capped at ~900 words |
| Sub-niche weights | +/-50% per cycle, clamped to 0.3-3 |
| Videos per week | +/-1 per cycle, hard ceiling `learning.cadenceCeiling` (4) |
| New topic areas | 1 per cycle, max `learning.maxLearnedSubNiches` (4), starts at low weight |
| Retiring a topic area | only with 4+ videos of evidence, never below 4 areas total |

Cadence only goes **up** when: 8+ mature videos, median pre-release score >= 7.5, <= 35% held or rejected,
and fewer than 5 quality incidents in 30 days. It goes **down** automatically if quality slips.

By default every change arrives as a pull request you merge. To let it apply changes without you:
```json
"learning": { "autoApply": true }
```
Only do that once a few cycles have produced sensible proposals.

## What happens when a video fails the final check

Nothing is thrown away, and the week's slot is not lost.

1. **Automatic repair, up to 2 rounds.** The check now tags every issue with an area (`image`, `script`,
   `title`, `thumbnail`) and a scene id. Image problems get a different picture with no re-voicing.
   Script problems get a targeted rewrite, and only the scenes whose wording actually changed are re-voiced.
   Then it re-renders and re-checks.
2. **If it passes after repair**, it publishes normally.
3. **If it still fails**, it goes to your GitHub issue queue with the repair history, and stays private.
4. **The weekly cap counts only videos that shipped**, so a held video does not consume the week's slot —
   the next scheduled run starts a fresh topic. A separate ceiling (`maxVideosPerWeek + 2` attempts/week)
   stops it burning quota when everything keeps failing.

`npm run why` shows the repair count and every issue with its area and scene.
`npm run retry` resets the newest video to redo media and checks from scratch.

## Why videos were being held (and what changed)

The first videos scored 4-5/10 almost entirely on `visualsMatch`. The cause was ordering: the script was written
first, then pictures were hunted to match it — so scenes about "sawdust under a microscope" or "an 1833 sailing
vessel" ended up with bread crumb macros and modern warships.

Now, before any production:
1. **Feasibility probe** — every scene's search runs against the real archive (metadata only, no downloads).
   Scenes with no genuine match get their searches rewritten, then re-probed.
2. **The forecast is told the measured number.** Below 80% findable, the predicted score is capped at 6,
   which triggers a pre-repair or abandons the topic before a minute of CPU is spent.
3. **Era routing** — scenes are marked historical/modern/any. Historical scenes search with period terms
   (engraving, lithograph, vintage photograph) and never touch modern stock photos or stock video.
4. **Fewer, longer scenes** — 14-20 instead of 25-31. Every scene is a chance for a picture to go wrong.

## Backup provider: never hand-type a model id

`grok 4` is xAI's model, not a Groq id — that error cost a run. Let the provider tell you:

```bash
# after putting OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY in .env
npm run models:backup
```

It lists what your provider actually serves, probes the largest ones with a real JSON request, and writes
working ids into `OPENAI_COMPAT_MODEL_HEAVY` / `_LIGHT`. Same idea as `npm run models` for Gemini.

## Generated cards

Some scenes have no honest photograph — a figure, a comparison, a process. Hunting the archive for those is
what produced pocket watches in a pipeline video. Now, when no image scores above 0.35 relevance, the scene
renders as a designed card built from the writer's own `cardHeadline` / `cardSub` (usually the scene's key
number). Cards are relevant by construction, licence-clean, and skipped by image QA.

The forecast judges the MIX: mostly photographs with a few cards reads as deliberate; more than half cards
caps the score at 6.

## How publishing works now

`produce` no longer schedules anything. It builds a **backlog** of finished videos (uploaded private,
status `ready`). The `queue` job runs daily and fills the week's slots:

- up to `maxVideosPerWeek` long videos (default 2)
- up to `shortsPerWeek` Shorts (default 2), taken from **different videos** than that week's longs,
  so a long and its own Short never go out in the same week
- anything left over stays queued for next week — nothing is wasted

`produce` keeps running while the backlog is below `backlogTarget` (default 4), so a quota-limited or
failed week never leaves the channel empty.

```bash
npm run queue     # fill this week's slots by hand (normally runs daily on GitHub)
```

## Manual publishing (publish.manual = true)

The queue no longer calls YouTube. Every weekday it:
1. picks slots for anything in the backlog that still needs one,
2. opens **"Publish today — <title>"** for anything due in the next 24 hours, with the Studio link
   and the exact IST time.

Videos are uploaded private the moment they finish producing, so Studio always has them waiting well
before their slot. You open the issue, click the link, set Public. Nothing else.

Default slots (chosen to suit a US audience while staying clickable from India):

| | IST | US Eastern |
|---|---|---|
| Long | Tue 6:30 pm | Tue 9:00 am |
| Short | Wed 8:30 pm | Wed 11:00 am |
| Long | Sat 7:30 pm | Sat 10:00 am |
| Short | Sun 9:30 pm | Sun 12:00 pm |

## Visual sources (all free)

| Source | Key needed | Photos | Video | Notes |
|---|---|---|---|---|
| Pexels | free key | yes | yes | 200 req/hour, 20k/month |
| Pixabay | free key | yes | yes | ~100 req/60s, no attribution required |
| Wikimedia Commons | none | yes | – | licence-filtered to commercial-use only |
| Openverse | none | yes | – | ~700M CC images, aggregated |
| NASA | none | yes | – | space topics, people/logos filtered out |

Get the Pixabay key at pixabay.com/api/docs (shown inline once signed in), then `npm run setup`.

**There are no text cards.** If a scene's own searches miss, the pipeline tries every source with every
query variant, then falls back to a prefetched pool of on-topic real footage. A scene never becomes a slide.
