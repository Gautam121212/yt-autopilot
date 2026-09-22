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

## Choosing the voice

I cannot hear audio, so the voice is the one thing I can't judge for you. Render the same line in
every option and pick with your own ears:

```bash
npm run voice:sample
```

It writes ~7 wav files to `work/voice-samples/` (American and British, male and female, two speeds) and
opens the folder. Put your choice in `config/channel.json`:

```json
"voice": { "provider": "kokoro", "voiceId": "bm_george", "speed": 1.0, "model": "onnx-community/Kokoro-82M-v1.0-ONNX" }
```

Available: af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky
am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa
bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis

A faster speed (1.05) and a drier voice both read as less "narrator".

## The framework (fixed structure, variable content)

**Beat sheet** — enforced by the schema, so a script that ignores it is rejected:
`cold_open → reaction → premise → escalation ×3+ → turn → mechanism → payoff → kicker`

**Shot rhythm** — research on faceless retention says a visual reset every 3–5s (vertical) and 6–9s
(horizontal documentary). The render cuts on sentence boundaries using Kokoro's own per-sentence
timings, so the picture changes exactly when the narration moves on:

| | target shot | source |
|---|---|---|
| Long video | ~7s | `SHOT_SECS_H` |
| Short | ~3.5s | `SHOT_SECS_V` |

Each scene gets 2–3 visuals from its `imageQuery` plus `altQueries`, and the writer is told to keep
**one idea per sentence** so audio and picture stay in sync.

**Topic pass gate** — a candidate is rejected outright unless: absurdity ≥ 7, retellability ≥ 7,
curiosity ≥ 7, evidence ≥ 7, illustratability ≥ 7, freshness ≥ 6, plus a named funniest true detail
and a one-sentence premise.

**14 sub-niches, 5 story shapes** — see `config/channel.json`.

## Generated clips (optional filler)

What the research actually found about free AI video in 2026:

| Option | Reality |
|---|---|
| Kling 3.0 | ~66 free credits/day ≈ **6 clips of 5s**. No public API. |
| Google Veo | ~100 credits/**month**. Not an API. |
| Runway / Luma / Pika | trial credits that expire; card required past that |
| Self-hosted Wan / LTX / Mochi | genuinely free and unlimited, but **needs an NVIDIA GPU**. GitHub Actions runners have none. |
| Pollinations `wan-fast` | free, no key, per-IP hourly limit — the only usable hosted option |

A 15-scene video needs 15 clips a day. No free tier supports that, so generated clips are wired in as a
**capped filler** for scenes stock cannot cover, not as a replacement:

```bash
# GitHub → Settings → Variables → Actions
AI_CLIPS=true
```

Max 4 generated clips per run (`AI_CLIPS_MAX`), tried only after Pexels and Pixabay both fail. Set
`POLLINATIONS_TOKEN` for higher rate limits if you register one.

Keep it off until the stock path is producing videos you like — a slow, rate-limited generator on top of
a broken edit just makes runs longer.

## The gates, end to end

`npm run audit` checks every one of these exists and is wired. Run it after any change.

| # | Gate | Bar | Cost if it fails |
|---|---|---|---|
| 1 | Topic: six axes (absurdity, retellability, curiosity, evidence, illustratability, freshness) | all bars + average ≥ 7.5 | 1 light call |
| 2 | Topic: can the story be filmed? | ≥70% of its 8-12 visual subjects exist in stock | 1 light call |
| 3 | Script: beat sheet | cold_open → reaction → premise → escalation ×3 → turn → mechanism → payoff → kicker | rejected by schema |
| 4 | Script: length | ≥1000 words after 2 expand rounds, else abandoned | 2-3 heavy calls |
| 5 | Script: facts | every claim traceable to the dossier | 1 heavy call |
| 6 | Scenes: image feasibility | ≥60% findable | 1 light call |
| 7 | **Every scene, one at a time** | **≥7.5/10, retried up to 3× with new queries; abandons if >25% fail** | 1 light call per scene |
| 8 | Forecast | ≥6.5 predicted | 1 heavy call |
| 9 | Final check | ≥6.5 and zero blockers | 1 vision call |

Nothing reaches the renderer until 1-8 have passed, so a bad idea costs a couple of small calls
rather than an hour of compute.

## One video a day, retried until it lands

Topic and script gates fail often — deliberately, and on light calls. So `produce` now runs **every 3
hours** and keeps trying until the day's video exists:

```
00:00 nothing yet          -> produces
03:00 topic dropped (7.1)  -> produces again
06:00 script too short     -> produces again
09:00 scenes below 7.5     -> produces again
12:00 one made it          -> stops
15:00 already won          -> exits in seconds
```

`videosPerDay` in `config/channel.json` sets the target (default 1). Publishing is separate and still
capped at `maxVideosPerWeek` long videos + `shortsPerWeek` Shorts — extra successes go to the backlog.

A run that finds the day already won costs one database query and exits, so eight crons a day is
cheap. The expensive calls only happen when there is actually work to do.

## Why runs used to die with "hit max tokens"

Flash models cap output at **8192 tokens**, and on thinking models the reasoning spends that same
allowance. Asking for 24,000 did nothing except hide the real ceiling, and uncapped thinking could
consume the whole budget and return MAX_TOKENS with no content at all.

Now: `maxOutputTokens` is capped at 8192, `thinkingBudget` is 1536 (leaving ~6.6k for the answer),
and a MAX_TOKENS failure retries with thinking disabled rather than by asking for a shorter answer.
Research input stays at 20,000 characters per page — the input was never the problem, and cutting it
would have starved the script of the specifics the comedy runs on.

## Audio mastering

Every serious faceless-video pipeline normalises before upload. The render now applies EBU R128
loudness normalisation to **-14 LUFS** with a true-peak ceiling of -1.5 dB and a limiter — YouTube's
own target, so your audio no longer sounds thin next to professional channels. Measured on a test
mix: -38.4 LUFS in, -13.6 LUFS out, video stream stream-copied and untouched.

## Guarding against regressions

```bash
npm run verify     # audit (30 gate checks) + selftest (20 schema/invariant checks)
```

The self-test parses realistic model answers against every schema and asserts the invariants that
past fixes have broken — including that the token fix did not trade away research quality.

## Fallback chain (so a quota wall never stops the pipeline)

Gemini first, then every provider you list, in order. Each has its own free tier, so one being
exhausted says nothing about the next.

```bash
# .env — name|baseUrl|apiKey|heavyModel|lightModel, separated by ";"
LLM_FALLBACKS="mistral|https://api.mistral.ai/v1|KEY|mistral-large-latest|mistral-small-latest; groq|https://api.groq.com/openai/v1|KEY|llama-3.3-70b-versatile|llama-3.1-8b-instant"
```

Free tiers with no card, measured September 2026:

| Provider | Free limit | Endpoint |
|---|---|---|
| Mistral La Plateforme | ~1B tokens/month (Experiment tier; opt in to training) | `https://api.mistral.ai/v1` |
| Groq | 30 RPM · 1,000 req/day · 100k tokens/day | `https://api.groq.com/openai/v1` |
| Cerebras | 30 RPM · 14,400 req/day · 1M tokens/day | `https://api.cerebras.ai/v1` |
| OpenRouter `:free` | 20 RPM · 50 req/day without a $10 top-up | `https://openrouter.ai/api/v1` |

**Mistral is the strongest single addition** — roughly a billion tokens a month is far beyond what
this pipeline uses, and its models write well enough to carry a script. Groq is fast but its per-day
token cap is small; treat it as a third link, not a second.

The existing `OPENAI_COMPAT_*` variables still work and are tried first.

## Bug registry

`BUGS.md` lists every defect found here, its cause, and the guard that prevents its return. Writing
the guard is part of fixing the bug. `npm run verify` runs all of them in about two seconds — it has
already caught a fix being silently reverted by a later edit.

## Who does what (role routing)

One provider doing everything is what made a quota wall stop the pipeline. The work is now split by
what each model is good at and what its free tier can carry:

| Role | Stages | Default | Why |
|---|---|---|---|
| `gate` | topic scoring, filmability, feasibility, per-scene checks | **Mistral** | many small calls; needs volume, not brilliance |
| `write` | research, script, expand, comedy pass | **Mistral** | the bulk tokens, ~1B/month free |
| `judge` | fact check, forecast, repairs, final review | **Gemini** | the only free provider here that can SEE images |

```bash
# .env
MISTRAL_API_KEY=...            # mistral.ai → La Plateforme, no card
LLM_ROLE_GATE=mistral
LLM_ROLE_WRITE=mistral
LLM_ROLE_JUDGE=gemini
```

Leave a role unset and it uses `LLM_PROVIDER` as before. A routed provider that fails falls through
to the default rather than failing the stage, and the `LLM_FALLBACKS` chain still sits underneath.

This is also why quality holds: Gemini's scarce quota is spent entirely on judging and repairing,
which is where a good model matters most, while the volume writing runs on a tier that cannot run out.

## The three bars

| Bar | Where | Effect |
|---|---|---|
| 7.5 | script forecast, **before rendering** | repaired twice, then abandoned — no pixels wasted on a 6/10 script |
| 7.5 | every scene's picture | retried with new queries; >25% failures abandons the video |
| 6.5 | final check | below this nothing is uploaded; notes go to the learning loop |

A rendered video scores at best about what its script forecast, so the 7.5 script bar is what makes
an 8/10 video likely rather than hoped for.

## Music

```bash
npm run music:make
```

Synthesises three documentary beds with ffmpeg — generated tones, so no licence and no attribution.
Measured: energy sits 35 dB below the speech band, so it never competes with narration. Replace them
with YouTube Audio Library tracks any time; anything in `assets/music/` is used automatically.

## Mistral: pick a model your key can actually call

A free Mistral key is **not** entitled to `mistral-large-latest` — it returns 403 and the routed call
silently falls back to Gemini, which defeats the whole split.

```bash
npm run models:mistral
```

It lists what your key may call, probes each with a real JSON request, and writes the working ones
into `MISTRAL_MODEL_HEAVY` / `_LIGHT`. Defaults if you skip it: `mistral-small-latest` and
`open-mistral-nemo`, both on the free tier.

A 403 in the logs now says so explicitly rather than showing a truncated error body.

## The daily target is unconditional

Once today's video exists, `produce` stops — whether it was triggered by cron or by you. `FORCE`
lifts the weekly *failure* cap only. To make more than one a day, raise `videosPerDay` in
`config/channel.json`.

## Mistral rate limits

Check yours at **admin.mistral.ai → Limits**. Most models are capped at **1.00 requests/second**,
which is the single most important number here: a burst of calls rate-limits you out of your own
quota. The pipeline now paces every call to an endpoint (`PROVIDER_MIN_GAP_MS`, default 1100ms).

Tokens per minute vary enormously and are worth choosing on:

| Model | Tokens/min | Req/s | Good for |
|---|---|---|---|
| `mistral-large-2512` | 250,000 | 1.00 | script writing (default heavy) |
| `ministral-8b-2512` | 625,000 | 3.13 | gate calls (default light) |
| `ministral-3b-2512` | 1,300,000 | 12.50 | high-volume checks |
| `mistral-medium-latest` | 20,000 | 1.00 | too small for a full script |
| `mistral-small-2603` | 20,000 | 1.00 | too small for a full script |

Use **dated ids**, not `-latest` aliases: an alias can resolve to a model your key is not entitled
to, which returns 403 while the dated id works.

`npm run models:mistral` probes at 2.5s intervals and retries a 429 twice before condemning a model
— it previously declared a working key dead by outrunning the limiter itself.

## If `source .env` shows a 401

Don't diagnose keys with `source .env`. One line it dislikes — `LLM_FALLBACKS` contains `|` and
spaces — makes it stop silently, leaving every later variable unset. The shell then sends an empty
bearer token and Mistral answers "Invalid API Key" for a key that works perfectly.

Test the way the app loads it:

```bash
npx tsx --env-file-if-exists=.env -e 'console.log(process.env.MISTRAL_API_KEY?.length)'
```

## Which Mistral models a free key is actually served

Not the impressive-sounding ones. On a free plan the `mistral-medium` family returns `1300
rate_limited` no matter how slowly you ask, while the **ministral** family works:

| Model | Tokens/min | Req/s |
|---|---|---|
| `ministral-3b-2512` | 1,300,000 | 12.50 |
| `ministral-8b-2512` | 625,000 | 3.13 |
| `ministral-14b-2512` | 937,500 | 0.50 |
| `mistral-medium-*` | 20,000 | 1.00 (returns 1300 on free plans) |

Defaults are `ministral-14b-2512` (heavy) and `ministral-3b-2512` (light). `npm run models:mistral`
probes in throughput order and reports which ones your key is served.

## Who does what, and why

Measured with `npm run providers`, not copied from documentation:

| Job | Stages | Provider | Why that one |
|---|---|---|---|
| `gate` | topic scoring, filmability, feasibility, per-scene checks | Mistral `ministral-3b` | dozens of tiny JSON calls; needs 12.5 req/s, not intelligence |
| `write` | research, script, expand, comedy | Mistral `ministral-14b` | one long answer; 937k tokens/min and no 8K output ceiling |
| `judge` | fact check, forecast, repairs | Mistral | reading and scoring text — no reason to spend Gemini on it |
| `vision` | image QA, final check | **Gemini only** | these look at pixels; no other free provider here can |

The point of the split: **Gemini's daily quota is now spent only on the two stages nothing else can
do.** Writing a 1,200-word script against Gemini's 8192-token output cap was the binding constraint
all week; Mistral has no such ceiling. A call carrying images is never routed away from Gemini, so
the vision stages cannot be broken by a misconfigured role.

```bash
LLM_ROLE_GATE=mistral
LLM_ROLE_WRITE=mistral
LLM_ROLE_JUDGE=mistral
LLM_ROLE_VISION=gemini
```

## Free providers that actually exist in 2026

GitHub Models is gone (retired 30 July 2026). What remains, measured September 2026 — no card
required for any of these:

Tested September 2026 with `npm run providers`. Advertised free tiers and real ones differ a lot:

| Provider | Status when tested | Notes |
|---|---|---|
| **Gemini** | ✅ works | the only one that can see images |
| **Mistral** | ✅ works | ~1B tokens/month; `ministral-14b` / `ministral-3b` |
| Z.ai GLM-4.7-Flash | ⚠️ error 1305 "model too busy" | 200K context when it answers, but one concurrent request and often congested |
| Cerebras | ❌ HTTP 402 payment required | the $5 credit needs a card; not a standing free tier |
| Groq | ⚠️ `gpt-oss-120b` fails JSON mode; `llama-3.1-8b-instant` retired | `qwen/qwen3-32b` is the working default |
| NVIDIA NIM | ❌ HTTP 410 Gone | the llama-3.x endpoints were retired |
| OpenRouter | ❌ the known `:free` slugs are now paid | check openrouter.ai/models?q=free for a current one |

**Two providers is enough.** Gemini for vision, Mistral for everything else, and Mistral's monthly
budget is far larger than this pipeline consumes. Extra keys add resilience, not capability.

**No single one replaces Gemini.** Each runs out in a different dimension — tokens per day, requests
per day, tokens per minute, context size — so the pipeline now treats a role as a *preference* and
tries every configured provider before falling back to Gemini.

Add as many keys as you like; all are optional:

```bash
# .env — every one of these is optional
MISTRAL_API_KEY=...      # mistral.ai → La Plateforme
ZAI_API_KEY=...          # open.bigmodel.cn  (best context for script writing)
CEREBRAS_API_KEY=...     # cloud.cerebras.ai (1M tokens/day, 8K context)
GROQ_API_KEY=...         # console.groq.com
NVIDIA_API_KEY=...       # build.nvidia.com
OPENROUTER_API_KEY=...   # openrouter.ai
```

With three of these configured the pipeline simply does not run out: a `write` call tries Z.ai, then
Mistral, then Groq, then Cerebras, then NVIDIA, then OpenRouter, and only then Gemini.

**Note on Cerebras**: 1M tokens/day sounds ideal but the free tier caps *context* at 8K, which a
script call against a full dossier exceeds. Use it for `gate`, not `write`.

## Checking every provider

```bash
npm run providers
```

Sends one real JSON-mode request to Gemini and to every configured provider, reporting what works,
what is rate-limited, and what is misconfigured — and, when a heavy model fails, whether the light
one works so you can use that instead. Tests what the pipeline actually does, because a key can list
models happily and still be refused a completion.

## Rejections are the design, not waste

The pipeline runs every two hours and expects most attempts to stop at a cheap gate — that is what
keeps expensive calls for topics worth finishing. So:

- **Only crashes count against the pause limit** (`maxCrashesPerDay`, default 6 in 24h). A crash
  means something is broken; a rejection means a gate did its job.
- **Every rejection teaches the next attempt.** The topic picker is shown the last fortnight's
  rejected topics and their weakest axes; the writer is shown why recent scripts failed.
  `npm run why` shows the same list.
- **Quality over length.** The floor is 750 words (~5 minutes). The writer still aims for 8-10, but
  a tight, good 5-minute script is no longer thrown away for being short.
- **Upload bar: 7.0.** Below it, nothing reaches YouTube.

## How footage is chosen

The way a human editor does it: lay the options out and pick.

1. For each scene, up to **9 candidates** are gathered from its own search, its backups and — when
   the scene describes motion — video clips. Only thumbnails are fetched at this point.
2. They go on a **numbered contact sheet**, and one vision call ranks the best three, asking the
   question an editor asks: *would I cut this shot under this line?* Stock never shows the exact
   historical moment, so strong B-roll — the right subject, material, setting or action — scores 7-8.
   Wrong era, a person as the subject, text, charts or clip-art score 0-4.
3. Only if nothing reaches 7.5, a **second sheet** from the editor's own suggested searches.
4. The top three become the scene's three cuts, downloaded at full size. Nothing else is downloaded.

At most two vision calls per scene, each seeing nine options — against up to three calls each seeing
one, under a rubric stock photography could not satisfy. Pexels searches are capped per run
(`PEXELS_RUN_BUDGET`, default 110) because other stages share its 200-per-hour limit; past that,
Pixabay carries the rest. Repeated searches are served from a per-run cache.

## Before the first full run: test footage selection for real

```bash
npm run select:test
```

Runs the real selector on three scenes that the old one scored 0-4/10, using real stock and real
Gemini. It saves every contact sheet (`sheet-*.jpg`, what the editor saw) and every chosen shot
(`sel-*`, what it picked) into `./select-test/`. Open them. If two of three clear the bar, the full
pipeline will find usable footage; if not, the printed reasons say whether the searches or the bar
is at fault. About 3-6 vision calls.

## Failure modes that no longer waste a run

- **Dead YouTube token**: checked before the first model call. The run stops, spending nothing,
  and tells you to run `npm run auth:youtube`.
- **Vision quota runs out mid-selection**: selection stops calling Gemini; unjudged scenes keep
  their fetched footage and do not count as failures. If over half are unjudged, the video is
  paused — research and script kept — and resumed by a later run (with a 3-hour cooldown).
- **Selection cannot starve the final check**: it has its own budget (`SCENE_VISION_BUDGET`, 36).

## Production dry run (no API keys, nothing uploaded)

```bash
npm run dryrun
```

Runs the real render engine on real synthesized speech and generated footage, then measures the
output: resolution, picture/speech sync, shot pace, bitrate, loudness, fast-start, render speed,
caption timing, and chapters against YouTube's rules. Frame sheets are saved in `./dryrun/` so you
can look at the result. About 3 minutes. Last measured: long video one shot every 5.9 s, Short every
3.2 s, -14.8 LUFS, 11.0 Mbps on worst-case noise, 2.0x real-time render.

## When Gemini is overloaded

Gemini's free models are regularly overloaded at the same moment. The pipeline now:
- waits out an overload (20 s, then 45 s) before giving up — quota errors are passed on at once;
- counts a scene it could not judge as **unjudged**, never failed;
- pauses the video (script and research kept) when over half its scenes are unjudged, and resumes
  it on a later run after a 3-hour cooldown;
- switches off, for the rest of the run, any backup provider whose key is refused;
- never sends pictures to a backup model that cannot see them.

## Who does what, and what happens when Gemini is down

| Stage | Provider |
|---|---|
| topic scoring, research, script, expand, comedy, fact check, forecast, repairs | **Mistral** |
| footage selection (contact sheets) and the final check | **Gemini** — the only free provider here that can see |

When Gemini is unavailable:
- **during footage selection** — scenes are marked unjudged; if over half are, the video pauses with its
  script kept and resumes from footage selection on a later run;
- **at the final check** — the finished render is saved as a workflow artifact (`pending-render-<run>`,
  kept 14 days) and the video waits at `rendered`. The next run downloads it and resumes at the final
  check: nothing is re-rendered, and no repair runs on a video nobody could judge. Still down? It saves
  again under the new run, so the artifact never expires while waiting. If it somehow has, the kept
  script is re-rendered rather than lost.

Both pauses wait 3 hours before retrying, and a waiting video holds the queue so no second video is
started that would also need Gemini to review it.
