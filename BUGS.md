# Bug registry

Every defect found in this pipeline, what caused it, and the automated guard that now prevents it
coming back. Adding to this list is part of fixing a bug — a fix without a guard is a bug waiting to
return, which is how several of these appeared twice.

`npm run verify` runs every guard in about two seconds.

## Pattern: what keeps causing these

1. **Patch-on-patch editing duplicates code.** A block is added next to an existing one that already
   did the job. → Guards must assert COUNTS, not presence.
2. **A rewrite silently drops a feature.** The new code path never calls what the old one did.
   → Guard: assert the feature is still wired, not just still defined.
3. **Two rules disagree by construction.** Min scenes × min words < the length gate; two probes with
   different thresholds. → Guard: assert the arithmetic between rules.
4. **A setting fixes one call and breaks another.** One global timeout for 3-second and 3-minute calls.
   → Guard: assert per-purpose settings exist.
5. **Config never updates.** `rsync` covers `src/` but not `config/`, so new defaults never land.
   → Guard: assert config contents, not just that the file parses.

## The registry

| # | Bug | Cause | Guard |
|---|---|---|---|
| 1 | Card text cropped ("X INSURED VALU") | Ken Burns zoom applied to text images | cards removed entirely; `audit`: no card code |
| 2 | Video 3.7 min against an 8-10 min target | nothing enforced total length | `MIN_WORDS` gate + `selftest`: word counter agrees |
| 3 | 32-second shots, 6 cuts in 226s | shot planner no-op when sentence timings missing | `selftest`: "shot cutting cannot silently fail" |
| 4 | Short captions at the top, clipped | `MarginV` is in ASS's 288-tall space, not pixels | `audit`: captions never over the fade |
| 5 | Image feasibility 0% on good queries | probe scored stock captions by word overlap; captions are synonyms | probe counts results; `selftest` era parity |
| 6 | Topic probe 100% vs scene probe 0% | era="historical" disabled stock sources in one path only | one shared `FINDABLE`; source list never shrinks |
| 7 | Historical scenes found nothing | period hint appended to stock queries too | hint applied per source |
| 8 | "Today's video done" at 05:30 IST | day boundary was UTC; dry runs counted as wins | `productionTimezone`; `selftest` asserts both |
| 9 | Research killed at exactly 120s | one global `LLM_TIMEOUT_MS` for every call | per-tier timeouts; `selftest` guard |
| 10 | "Gemini hit max tokens", empty content | asked 24k against an 8192 cap; thinking shared the budget | cap + `thinkingBudget`; `selftest` guard |
| 11 | Crash on `uncertain[0]` | schema demanded strings, model returned objects | union + transform; `selftest` parses both |
| 12 | Schema-valid script failing the length gate | 12 scenes × 75 words = 900 < 1000 | min 13 scenes; `selftest` asserts the arithmetic |
| 13 | Audio ducked and normalised twice | added passes next to existing ones | `selftest`: exactly one of each |
| 14 | Music silently disappeared | shot-based rewrite orphaned `pickMusic` | `selftest`: one picker, and it is called |
| 15 | Scheduled runs never fired | cron at minute 0, which GitHub drops under load | staggered off-peak crons; `selftest` guard |
| 16 | NASA imagery in non-space videos | listed as a visual source | removed from the schema; `audit` + `selftest` |
| 17 | Old 8 sub-niches still in use | `rsync` skips `config/`, so new defaults never landed | `selftest`: asserts ≥10 sub-niches |
| 18 | Production paused for a week | runaway guard counted human rejections as waste | counts only `failed`/`abandoned` |
| 19 | Six heavy calls before a cheap gate | gates ran in the wrong order | `audit`: stage ordering |
| 20 | Everything stopped when one backup failed | a single fallback provider | `LLM_FALLBACKS` chain; `selftest` guard |
| 21 | Timezone fix silently reverted | a later restructure of `produce.ts` overwrote the region containing it | `selftest`: asserts `productionTimezone` is used in the query — caught this within minutes of being written |

| 22 | Whole pipeline stopped when Gemini's quota ran out | every stage used one provider | role routing: writing on Mistral, judging on Gemini |
| 23 | A 6/10 script still consumed an hour of rendering | quality was only checked after production | `minScriptScore` 7.5 gate before any render |

| 24 | Audit's stage-ordering check failed on a code comment | it matched bare words like "rendering" anywhere in the file | matches log CALLS (`} rendering\``), not prose |

| 25 | Mistral 403 on every call, silently falling back to Gemini | default `mistral-large-latest` is not on the free tier | free-tier defaults + `npm run models:mistral`; the 403 now explains itself |
| 26 | 601-word script after two expand rounds | the brief gave a TOTAL word target; models work to per-item quotas | per-role word budget; expand names the short scenes and their targets |
| 27 | Expand hit MAX_TOKENS | thinking budget took a share of the 8192 output cap on the longest-output call | `thinkingBudget: 0` for writing passes |
| 28 | Manual run ignored the day's target | `FORCE` bypassed the daily quota as well as the failure cap | daily quota is unconditional; `FORCE` only lifts the failure cap |

| 29 | `.env` role settings ignored in CI | `github.sh` pushes them as SECRETS; the workflow read only `vars` | workflow reads `secrets.X \|\| vars.X \|\| default`; guard compares the two files |
| 31 | Prober declared a working Mistral key dead | it fired ~1.7 req/s against a 1.00 req/s limit and treated 429 as "unavailable" | paced to 2.5s, retries a 429 twice with backoff before condemning a model |
| 32 | `-latest` aliases 403 while dated ids work | an alias can resolve to a model the key is not entitled to | defaults are dated ids taken from the account's limits page |
| 33 | A run could rate-limit itself mid-production | no pacing between calls to the same endpoint | `paceFor()` enforces a minimum gap per endpoint |
| 35 | Prober tested only models this plan cannot call | it ranked by name ("medium" > "ministral"), so it never reached the working models and stopped after 10 | ranks by the throughput the limits page grants; probes every listed model |
| 38 | Script bar repaired twice to the same 7/10 | repairing a structurally-fine draft cannot lift it; only a different draft can | attempt 2 rewrites from scratch with the critique |
| 43 | **Every run died at "Gemini hit max tokens"** | a global 4,096 output cap (added for Groq) truncated every Mistral script mid-JSON | per-provider caps (Mistral 32k); `replay` scenario 1 |
| 44 | Mistral's truncated answer silently went to Gemini | unparseable JSON skipped the retry and fell through to Gemini in the same attempt, with no log | unparseable answers retry the routed provider; `replay` scenario 2 |
| 45 | Truncation looked like a mystery parse error | `finish_reason` was never read | `TruncatedError` on `finish_reason: length`, retried on the same provider; `replay` scenario 3 |
| 46 | A failing writer burned Gemini quota for nothing | writing calls fell back to Gemini, whose 8192 cap cannot hold a script | writing never falls back to Gemini; gates still may; `replay` scenarios 4-5 |
| 72 | **An outage abandoned a good script — "13/13 scenes below 7.5"** | a vision call that ERRORED was counted as a scene that FAILED; my #61 fix only caught errors shaped like quota, and this one arrived as a fallback's 401 | an error is "unjudged", never "failed"; two in a row stops selection; over half unjudged pauses and resumes the video; `replay` 26 |
| 73 | A dead backup key was called for every scene; Gemini never got its timeout or thinking budget | no circuit breaker; the fallback's own 401 replaced the real cause; overload and quota handled identically with no waiting; an old edit targeted a variable that did not exist, silently | refused keys disabled for the run; the original error re-raised; overloads waited out (20 s, 45 s), quota passed on at once; parameters passed through; `replay` 26 |
| 73b | A text-only fallback could "rank" pictures it never saw | images were dropped silently and the model answered anyway | calls carrying images never go to a blind model; `replay` 27 |
| 74 | **The learning loop was fed wrong lessons** | footage failures were taught to the WRITER, and outages were recorded as content failures — so the same real mistakes kept recurring while noise crowded out signal | footage lessons go to the topic picker; anything reading as an outage is excluded; `replay` 28 |
| 75 | Mistral failed validation on most first attempts, wasting heavy calls | strict formatting rules (exactly 3 titles, <=15 tags, exact enum spelling, fixed caption lengths) rejected complete scripts; the log never said which | every such rule normalises instead; the retry log now names the failing field; `replay` 29 |
| 76 | Five nested exponential retries per model per round | Gemini's inner retry (5 tries) stacked under the new outer waits: ~5.5 min per vision call in an outage | inner retry 2 tries; outer loop owns the patience: ~83 s |
| 66 | Video uploaded at 21 Mbps (~1.6 GB per 10 min) | no bitrate ceiling; then a ceiling with a 2 s buffer that each short per-shot clip could burst past | 10 Mbps ceiling, 1 s buffer, on every encode; measured by `npm run dryrun` |
| 67 | **Chapters effectively never worked** | built from an optional field the writer rarely set, so most videos got a lone "0:00 Intro" (ignored by YouTube); split scenes (#50) duplicated titles seconds apart, and one chapter under 10 s disables all of them | built from the beat sheet; first at 0:00, >= 3, each >= 10 s, or no section at all; checked against real render timings |
| 68 | The model guarding the 7.5 script bar forecast a video we do not make | its prompt said unmatched scenes become text cards (deleted in #1) and footage comes from Commons and NASA | prompt describes the real pipeline: stock B-roll chosen from contact sheets, no cards |
| 69 | Thumbnail could be built from a frame that was never written | trusted ffmpeg's exit code (the #56 class) | checks the file on disk |
| 71 | Short captions under YouTube's overlay | MarginV=34 placed the second line ~12% from the bottom, where the Shorts UI shows the channel name and title | MarginV=80 (~28% up), seen on a dry-run frame sheet |
| 70 | (improvement) viewers who clear minute one watch far longer; looping Shorts are rewatched | — | premise ends with a payoff roadmap; the Short's kicker leads back into its opening |
| 64 | **Run stuck ~40 minutes before the first scene** | the spare-footage pool ran BEFORE the phase clock started and had no limit of its own; every call had a timeout, but 10 queries x 4 sources x retries and 60 s downloads summed to half an hour | pool limited to 3 min, stock only, inside the phase clock; the whole phase has a hard ceiling; `replay` 25, proven red |
| 65 | The run log said "images (NASA)" | stale text left from before NASA was removed (#16) | log says "footage" |
| 61 | A vision quota wall mid-selection would abandon a good video | quota errors counted each remaining scene as a failure, tripping the 25% rule; nothing stopped selection spending the quota the final check needs | selection stops on quota, marks scenes unjudged (not failed), has its own vision budget; over half unjudged pauses the video and a later run resumes it; 3h cooldown; `replay` 22-23 |
| 62 | An expired YouTube token would fail at upload, after everything | `invalid_grant` only surfaced at the last step | preflight checks the credential before the first model call |
| 63 | The selector's judgement was only ever tested with a scripted model | the replay proves mechanics, not taste | `npm run select:test` runs it on real stock with real Gemini and saves what it saw |
| 59 | **The final check would have held every B-roll video** | #55 fixed the rubric in the selector but not in the final review, which still held any image that did not "depict what its narration says" — after rendering, the most expensive point; its prompt also still called the footage "the NASA image" | the review uses the same B-roll standard; guard compares the two |
| 59b | Short footage was landscape cropped to 9:16 | candidates were always landscape; the crop discards two-thirds of each frame, and the editor judged the uncropped version | Shorts request portrait (topped up with landscape); sheet tiles show the cropped frame; `replay` 20 |
| 60 | The Pexels run budget saw only half the traffic | the counter lived in the selector; the fetch stage and the probe called Pexels uncounted | one shared budget in `lib/budget.ts`; `replay` 21 |
| 55 | **Every scene scored 0-4/10** | the rubric demanded a literal depiction that stock cannot provide ("merely not wrong is a 5"); and each search's 30-40 results were cut to ONE, chosen by caption word-overlap (#5), then judged alone | candidates from several searches on a numbered contact sheet; one vision call picks the best three as a B-roll editor would; a second sheet only if needed; `replay` 15-19 |
| 56 | ENOENT on `preview-sc07-2.jpg` crashed a scene | `-ss 1` on a clip shorter than a second exits cleanly without writing a file, and the code trusted the exit code | selection works from thumbnails; every generated file is checked on disk; `replay` 18 |
| 57 | Scenes searched for things unrelated to their narration | snapping (#19 fix) overwrote any off-list search with an approved subject ROUND-ROBIN, i.e. an arbitrary one | a scene keeps its own search; nearest approved subjects are added as backups; feasibility still passes because it takes the best of all |
| 58 | Gemini's 7-second gap could not be tuned | hard-coded in `gemini()` | `GEMINI_MIN_GAP_MS` |
| 51 | **Production paused for a week after one normal day** | the waste cap counted gate rejections, which the 2-hourly retry design produces on purpose; and rejections were never fed back, so the same weakness recurred | cap counts crashes only (24h, 6); topic drops now recorded; the picker and writer read recent rejections; guard proven red against the old query |
| 52 | Good 5-minute scripts discarded | a 1,000-word floor valued length over quality | floor 750 words (~5 min); the writer still aims for 8-10 |
| 53 | Upload bar below the stated standard | final bar was 6.5 | raised to 7.0 |
| 54 | The weekly learning job never ran | it waits for 8 mature published videos; with none published, rejections were never examined | the per-run lessons loop (#51) works from the first rejection |
| 50 | Complete scripts binned for having 11 scenes | the per-role table (#26) allowed a minimum of 11 while the schema (#12) demanded 13 — two of my own fixes disagreeing; and the schema rejected rather than repaired | table minimum raised to 13; schema accepts 9+; `normaliseSceneCount` splits long scenes to 13 for free; selftest parses the table and asserts the sum; `replay` 10-12 |
| 47 | A "factually accurate" script abandoned by the fact checker | the verifier also judged TONE as a major issue and took the model's "abandon" at its word; tone is subjective, so it could never pass | verifier scoped to facts and policy; verdict derived from blocking issues; tone kept as advisory; `replay` 8-9 |
| 48 | Nearly every judge call failed validation and retried | the prompt asked for "tone" issues the schema's category enum did not contain | unknown categories map to "quality"; ids and severities normalised; `replay` 7 |
| 49 | Two replay scenarios passed while testing nothing | roles are read at module load, so setting one mid-test left it unrouted; one check counted calls instead of checking the result | roles set before import; checks assert outcomes |
| 41 | Gemini's scarce quota spent on text-only judging | one "judge" role covered both reading scripts and looking at pixels | split into `judge` (text, Mistral) and `vision` (Gemini only) |
| 42 | Provider defaults pointed at dead or paid models | copied from documentation rather than tested | every default now matches what `npm run providers` actually returned |
| 40 | A broken key was only discovered mid-run | nothing tested providers end to end | `npm run providers` sends a real JSON request to each; guard keeps it in sync with the client |
| 39 | A failing routed provider dropped straight to an exhausted Gemini | the role named one provider and nothing else was tried | the role is a preference; every configured provider is tried first |
| 37 | "✅ Uploaded" printed when nothing was uploaded | the message fired on any zero exit; abandoning at a gate, and holding a video, both exit 0 | the finish line reads the database and reports the real outcome |
| 36 | `source .env` reported a valid key as 401 | one odd line (`LLM_FALLBACKS` contains `\|` and spaces) makes `source` stop, leaving later vars unset | diagnose with `npx tsx --env-file-if-exists=.env`, never `source` |
| 34 | Routed calls ignored the shrinking retry budget | the routed path used a fixed `maxTokens`, so an overflow repeated the same oversized ask | routed and fallback calls use `Math.min(budget, …)` |
| — | *(nearly #35)* A second Gemini pacer | `grep paceFor` missed the existing `lastGemini` timer, which uses a different mechanism | guard asserts exactly one pacer per provider; read the function, not the search result |
| 30 | Mistral 429 on every model | free tier needs phone verification before it serves anything; prober also fired 10 requests in 6s | prober paced to ~1 req/1.8s and explains a universal 429 |

## Why `replay` exists

Bugs #43-#46 all passed every string-based guard. `grep` confirmed the fallback chain existed, the
routing was wired, the caps were set. None of it asked what actually *happens* when Mistral returns
a truncated answer — and that was the only question that mattered. `npm run replay` feeds the real
client a scripted network and asserts behaviour: which provider was called, how many times, with
what budget. It caught one bug in my own fix for #45 before it shipped.

## Adding a bug

1. Add a row: what broke, what caused it, which guard catches it.
2. Add the guard to `scripts/replay.ts` if it is about what HAPPENS (preferred — replay the real
   failure), `scripts/selftest.ts` for shapes and invariants, `scripts/audit.ts` for wiring and order.
3. Confirm the guard FAILS against the old code, then passes against the fix. A guard never seen red
   proves nothing.
