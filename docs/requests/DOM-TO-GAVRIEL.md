## 2026-11-24 20:10 (DOM): first pre-filter run, 7.3.1

1. **The 15:25 UTC run did not start by 16:52.** GitHub starts this repo's scheduled runs 3 to 10 hours late. DOM ran it by hand, and 7.3.1 makes it try every hour. Wait for `runs/DATE.json`; do not assume a time.
2. **Counts, 24 Nov:** auctions read 115,187, checked 247, logged 246, killed 1 (vaporizor.com, history). Closeouts read 386,152, logged 403. Web Risk: 649 clean, no errors; the secret works.
3. **History is the weak check:** auctions 92 no hits (most are `partial`), 3 suspect, 1 no snapshots, 22 errors, 128 not checked; all 403 closeouts not checked. The 40 minutes cover about 119 names. Please check the history of Buyer's picks by hand.
4. **mineunited.com:** `renewal_cents` 2393 is set, as you asked.
5. **CR-118 is not started.** Dvir told DOM on 24 Nov to require one bid; DOM asks Dvir. Measured today: up to 15,826 auctions a day would be added. Web Risk's free quota is 100,000 lookups a month, and that is up to about 475,000; with 40 minutes of Wayback nearly all would stay unchecked.
6. **CR-119:** DOM adds the row when the list price is decided.

## 2026-11-24 08:32 (DOM): CR-117 is built in 7.3.0

Dvir's yes to DOM, 24 Nov: build it with the four changes below, and founder rule 5 now allows the $300 closeout pilot (MineUnited's $24.19 counts, so $275.81 is left). Each buy still needs his yes. Read `docs/contract/prefilter.md` and "The budget rules" in `docs/contract/endpoints.md`.

**Changed from the CR, with Dvir's yes**
1. Auctions need at least one bid. The CR's gates alone left 125,344 names; with a bid and ending tomorrow it was 243 on the 23 Nov file.
2. The log is public, so our maximum and planned BIN are never in it, not even after the close. Please keep them on your side.
3. GoDaddy cannot list our bids: you give the open bids and the renewal price to `/budget`. Logged names are always `budget: unknown`.
4. No public file has a final price. The log has the last one seen on the closing day. Please read the final price for Buyer's picks.

**DOM's choices:** closeouts need the same name live on 3 other endings and 5 years of age (432 on the 23 Nov file). Spamhaus is not called: its free lists are for non-commercial use only. Wayback is by page addresses, no titles, within 40 minutes a day. The filter is not an API route: the files are too big for Render. The log is read by raw URL.

**Please**
1. Add the repository secret `GOOGLE_WEB_RISK_API_KEY` in GitHub (the same key as in Render). Until then the log says `missing_key`.
2. Send the yearly renewal price of mineunited.com at GoDaddy. Until then `/budget` answers `unknown`.
3. Put new kills in `docs/requests/kills.txt`, one name a line. DOM seeded it with the old ones.
4. Update `bot-logic/04-buyer-current-process.md`: closeouts now have the pilot, and the source is the shadow log.
5. A purchase request names its source: `auction`, `closeout`, `fixed_price` or `registration`.

## 2026-11-24 06:30 (DOM): CR-116 is live in 7.2.0, except the inventory files

Checked live on Render (`d216ba52`): `/check` has `web_risk` (it answered `clean` for promptinjectionaudit.com; a flagged name was tested with fakes only). `/registrar-status` reads the three Porkbun names: auto-renew **off**, locked, Afternic nameservers, expiry equal to our record. The other sources answer "missing key". Routes, errors and key names: `docs/contract/endpoints.md`. `GET /health` shows which keys are set.

1. **Keys still missing in Render:** `GODADDY_DOMAINS_PAT`, `AFTERNIC_API_KEY` + `AFTERNIC_API_SECRET`, `USPTO_API_KEY`. Their answers are built from the official docs and not tried live; tell DOM when each is set and DOM checks it. Until the PAT is set, auto-renew of mineunited.com and promptinjectionaudit.com is unknown.
2. **Please hold `GODADDY_API_KEY` + `GODADDY_API_SECRET` (Auctions).** By GoDaddy's docs the same classic key can bid and buy with a saved payment method, and they show no read-only form. Dvir: no money spending from the app. DOM asks Dvir. Do not save a payment profile for it.
3. **The Afternic key can change listings** (its docs show no read-only key). The app has no call that does. Dvir should know before it is made.
4. **Porkbun:** its keys can be limited to the `read` permission. Please replace the key in Render with a read-only one, with Dvir's yes; then nothing there can buy.
5. **GoDaddy has no call that lists our bids** (the Auctions API has availability, bid, payment profile and purchase only). The CR-117 plan to read open bids through it does not work.
6. **Inventory files moved to CR-117's daily job.** The closeouts alone are 327 MB of JSON, and each page of an API answer would read the file again on Render's free server.
7. **CR-117:** not started; Dvir wants CR-116 finished first. Its ledger baseline should be $76.15.

## 2026-11-23 16:42 (DOM): CR-114 and CR-115, Dvir's decision

Dvir, to DOM in chat today: **"no money spending from the app"**; founder rule 12 stays. This replaces the approvals quoted in both CRs for those parts.
- **Closed, not built:** register, renew, bid and buy routes, the approval files under `docs/requests/approvals/` and the `money` flag.
- **Also not built:** set nameservers, and listing add, update, remove and price. They spend nothing, so Dvir's line does not name them, but the app stays read-only and DOM adds no write route. Sales and nameserver steps stay by hand, with Dvir's approval.
- **Read parts:** built, see the 24 November entry.
- **$1,500 total cap: added** to founder rule 2 and `npm run check-state` (Dvir to DOM, 23 Nov). Every cost counts (the membership too); a sale adds no room. $76.15 is spent.
- **The repo stays public for now** (Dvir to DOM, 23 Nov).
- **Please note:** CR text that quotes Dvir is public.

Buying stays by hand: Dvir approves, Gavriel buys in the browser, a request here, DOM commits the row.

## 2026-11-23 16:40 (DOM): deploy

**Deploy (S-10): works while the repo is public.** Checked by DOM: the repo is public, changed at about 16:25 Israel time, 25 seconds before `b9ef41da` started deploying. DOM had written that it worked with the private repo; that was wrong. The stale lines in `CLAUDE.md`, `README.md` and `DEPLOYMENT.md` are corrected, as you asked.

## 2026-11-23 (DOM): answers to the Architect

**What exists now (7.1.0):** a read-only API with seven routes (`docs/contract/endpoints.md`) on `https://domain-trading-api.onrender.com`. State is `data/state.json`. Wake it with `GET /health/ping` and wait up to 180 s.

1. **The repo is public** (see above). Everything committed here can be read by anyone.
2. **Token:** `grok-bot` is in `data/access.json` and works; `TOKEN-grok-bot.md` is deleted.
3. **Membership (S-7):** ledger row 6 is live, 2026-10-28, $4.99, order 4205792951. Total $76.15, five domain rows unchanged.
4. **Four listings (S-8):** closed on your word.
5. **Render URL (S-3):** tell DOM when every routine has moved. DOM then deletes the old proxy.
6. **Render keys:** 7.1.0 reads none of `JOB_TRIGGER_TOKEN`, `APP_ENV` and `PUBLIC_BASE_URL`. All three can go, with Dvir's yes.
7. **Never Dvir's email in a file.** DOM took it out of the receipt note.

A purchase, renewal, cost or sale: a request here with Dvir's approval; DOM commits the row. Price drops are by hand (`docs/internal/pricing.md`).

## 2026-11-26 (DOM): CR-129 and CR-127 Part A built, PR #9

PR https://github.com/DvirBaumel8/domain-trading/pull/9 (one commit per actor: wayback-domain-history, broken-link-auditor, bulk-pagespeed-checker, each 0.1.0). CI: GitHub ran no check on the PR; run locally: pytest green for every actor and for the repo-wide contract tests, and `npm test`, `tsc`, `build` green. `check-state` could not run in the shallow clone. **Left:** (1) Dvir installs the two workflow files from `apify-actors/ci/` (the App has no `workflows` permission), so the `apify-actors.yml` CI and the bot text guard are not live yet; (2) no Apify push: no token here and it needs Dvir's machine, so there are no Apify actor ids; (3) READMEs are first drafts for you to rewrite; (4) no prices set; (5) CR-127 Part B not built (waits on Q2). Note for the bots: wayback `totalSnapshots` counts one capture per day, not every raw capture.

## 2026-11-26 (DOM): CR-130 and CR-127 Part B built

`apify-actors/tools/apify_guard.py` (post-push GET check: fails on `isPublic: true` or any pricing; id, name, build to the job summary and an artifact with the line for this file), `tools/apify_usage.py` (daily usage, deltas, current vs pending prices, earnings note, no file on 401/429), tests in `tests/test_push_and_usage.py`, and two workflows in `apify-actors/ci/` (`apify-push.yml`, `apify-usage.yml`) for Dvir to install. Old `usage-report.py` removed. Nothing pushed to Apify, nothing published. The DOM-TO-GAVRIEL line after a push comes from the job summary: add it by PR.

## 2026-11-26 (DOM): CR-134 AI brand mention check actor built (issue 77)

`apify-actors/ai-brand-mention-check/` on branch `claude/issue-77-20261126-2242` (no PR, per the issue): ChatGPT, Gemini and Claude by REST with web search, one row per question and engine, `SUMMARY` record, tests A1–A29 offline (76 tests, fake providers, fake clock). CI run: the `apify-actors` run on the branch push (link in the issue 77 comment). Added to the code map, `IN_SCOPE` and the ci copy of the push allow-list. **Left:** (1) Dvir installs `apify-actors/ci/apify-push.yml` (the bot cannot change `.github/workflows`); (2) not pushed to Apify, so no id: `sync-store-meta.py` has a marked TODO, add the id after the first private push; (3) no price, no provider keys anywhere, no AI spend, no logo (optional, skipped); (4) README is a first draft; (5) the actor.json version is `0.1` because the repo test requires MAJOR.MINOR (changelog says 0.1.0); (6) the word list is from `wordfreq` (data CC BY-SA 4.0), recorded at the top of `matching.py`. Live acceptance on real brands waits for a small approved budget.

## 2026-11-27 (DOM): issue 102, Site Migration QA defaults and clean exit on bad input

Branch `claude/issue-102-20261127-0739` (no PR, per the issue; commit is the branch head). Site Migration QA: default run timeout 7200 s, default Max URLs 200 (was 1000). Site Migration QA, Bulk Domain Availability Checker and Sitemap URL Extractor: bad input now ends SUCCEEDED with a status message and a `STATUS` key-value record (`ok: false, reason: invalid_input`), not `Actor.fail()`; nothing pushed or charged. "No valid domains or keywords in input." restored for the domain checker. **Left:** nothing is pushed to Apify; `apify push`, a live check of the new defaults and of the clean exit wait for Dvir.

## 2026-11-27 (DOM): issue 105, live rebuild of public Actors by workflow

`apify-push` now has a LIVE path for `bulk-domain-availability-checker`, `sitemap-url-extractor` and `broken-link-auditor` (public, priced): manual dispatch, or automatic on a merge to `main` that changes `apify-actors/<name>/**` (only the changed live Actors; pytest first). It never publishes, unpublishes or sets a price; the check fails if visibility, listing text, categories or price changed, memory is not 256, or Site Migration QA timeout is not 7200. Private path (`wayback-domain-history`, `bulk-pagespeed-checker`, `ai-brand-mention-check`) keeps its guard. Anything else: "actor not allowed". Branch `claude/issue-105-20261127-0755`, no PR, nothing pushed to Apify. **Left:** if `.github/workflows/apify-push.yml` is not on `main` as written, copy `apify-actors/ci/apify-push.yml` over it.

## 2026-11-27 (DOM): new way to reach DOM (Dvir, 27 Nov)

Dvir chose **one DOM that starts by itself**. From now on:

1. **To ask DOM anything, commit a file to `docs/requests/` on `main`** (a CR, a REQ, or a note here). Every push starts a DOM session in the cloud within a minute or two. It reads the request, answers in the file or here, builds approved CRs and pushes to `main`. Dvir can watch each run live at claude.ai/code and type into it.
2. **`@claude` GitHub issues no longer work.** The `Claude Code` and `Claude Code Review` workflows are switched off, so there is one builder. Still open: issues 12, 14, 117, 118 (with `@claude`) and 57, 67, 76, 78, 88, 128, 131 to 134, plus PRs 70 and 87. **Move each one you still want into a file in `docs/requests/`**, then close the issue. DOM will not read issues.
3. **Commit as one of Dvir's bots** (author name with "Grok Bot", or "Buyer"). Pushes by anyone else start a session that ends at once.
4. Money actions still need Dvir's own line for that action, now typed in the DOM session. DOM writes here what the line must name.
5. No DOM pushes between 23:45 and 01:00 UTC. A request sent then is handled after 01:00.

## 2026-11-27 (DOM): CR-135 Podcast Transcriber built (your request of 26 Nov)

`apify-actors/podcast-transcriber/` is on `main`, version 0.1 (`CHANGELOG` 0.1.0). Built as `dom-request.md` says. Offline tests U-01 to U-30 are in `tests/` and pass locally: 92 passed, plus the repo-wide tests (230). The live suite A-01 to A-14 is in `tests/live/`, skipped unless `LIVE_TESTS=1`. A-04 and A-14 also need `LIVE_SPEND_OK=1`. Nothing is pushed to Apify, published or priced. Commit `e9a123b8`; CI `apify-actors` run 75 green (https://github.com/DvirBaumel8/domain-trading/actions/runs/45985867387). Until the staged `apify-actors.yml` with `ffmpeg` is installed, the ffmpeg-based tests (U-12, U-13 silence cuts, U-27 golden run) may be skipped in CI; locally they pass.

**Conflicts and what DOM decided:**
1. **Description too long.** Your `actor-text.json` description is 414 characters. Apify and `tests/test_listing.py` allow at most 300. DOM shortened it to exactly 300 with the same content. Title, SEO texts and README are your drafts unchanged. Replace the description with your own text whenever you like, at most 300 characters.
2. **Version.** The Apify CLI takes only `MAJOR.MINOR`, so `actor.json` says `0.1`. The `CHANGELOG` says 0.1.0.
3. **One extra environment variable:** `ACTOR_DEFAULT_KEY_VALUE_STORE_ID`. Without it, the `files` links in each row could not point to the stored transcript files. It is a platform variable, not a secret. It is named in `tests/test_listing.py` next to your list.
4. **`all-new` in `apify-push` keeps its three Actors.** Push `podcast-transcriber` by choosing its own name.
5. **The Gemini request body is a best guess.** The answer parser is tested on your recorded answer. The request fields (`audioTranscriptionConfig`, `wordTimestamps`) still need checking. Please check them on the first live A-01 run and tell DOM if Gemini answers 400.
6. **Language detection falls back to null.** When the engine gives no language, the row's `language` is null; there is no separate 60-second language-id call in 0.1.
7. **Some A-tests need the platform.** A-13 (spending limit) and the "charged events" checks in A-01 to A-03 only mean something on a private Apify run with pay-per-event set. On a local `apify run`, check the rows only.

**Needs Dvir (through you):**
- **Copy two staged workflow files** over the ones in `.github/workflows/`: `apify-actors/ci/apify-actors.yml` (installs `ffmpeg`, so the audio tests run in CI instead of being skipped) and `apify-actors/ci/apify-push.yml` (adds `podcast-transcriber` to the private allow-list and sets 1024 MB and 7200 s after the push).
- **Then the private push:** run `apify-push` with `podcast-transcriber`, or `apify push` from Dvir's machine. This needs Dvir's OK. Afterwards, add the actor id here and to `tools/sync-store-meta.py`.
- Engine accounts and keys (D1 Groq, D2 AssemblyAI, D3 secrets on Apify), price (D4) and publish (D6) are Dvir's decisions, as in the spec. Nothing here needs them yet: with only `GEMINI_API_KEY` set, Gemini is the engine.

