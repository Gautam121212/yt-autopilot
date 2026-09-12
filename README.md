# yt-autopilot

Space & astronomy explainer channel built on real NASA imagery: one long video + one vertical Short
per topic, fully automated on GitHub Actions.

## Pick your AI provider at setup (`npm run setup`)

| Provider | Cost | Web search during research | Looks at the rendered frames |
|---|---|---|---|
| **Gemini free tier** (default) | $0, no card | no — Wikipedia only | yes |
| Claude Pro/Max subscription | your existing plan | yes | yes |
| Anthropic API key | ~$2-5 per video | yes | yes |

Everything else is free on every path: Kokoro voice (runs on the GitHub runner), NASA Image Library,
YouTube APIs, GitHub Actions, Neon Postgres.

## Pipeline

```
produce (Mon/Thu) : YouTube outlier demand -> topic -> Wikipedia dossier -> script + Short
                    -> fact/policy check (<=2 revisions) -> NASA images + Kokoro voice -> render
                    -> FINAL CHECK: the model sees the thumbnail, 16 frames of the long video and
                       8 of the Short, may improve the title, then decides publish or hold
                    -> upload PRIVATE -> schedule, or a GitHub issue for you
analytics (daily) : views, watch time, avg % viewed, retention curve
learn (weekly)    : playbook + sub-niche weight changes proposed as a pull request
```

Approval lives in `config/channel.json -> approval`: by default the model publishes on your behalf at
>= 7/10, except your first 3 videos which come to you as GitHub issues.

All commands are in **SETUP.md**.

## Known limits
- Gemini free tier: Flash models only, roughly 10-15 requests per minute, and Google may use free-tier
  inputs and outputs to improve their models. Quotas have been cut before without notice.
- Without web search (Gemini path), research is Wikipedia-only by design; the prompt forbids inventing sources.
- The reviewer and the writer are the same model family, so the review is less independent than two providers would be.
- Impressions and CTR need the YouTube Reporting API (not wired).
- Publish-time learning needs many videos per slot before it means anything.
