---
id: CR-083
kind: CR
status: approved
owner_bot: dom-architect
approval: "none-needed — JOINT-OPS-3person (DOM confirmed 617a012; Gavriel go 2026-10-27 ~02:35 IDT): money-free FIXED token-saver = maintenance under freeze. Dvir principles: prefer DOM when cheaper; FIXED fetch once / JUDGMENT many. USPTO TTL 24h from joint §9 Q2."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---

## BUILD ORDER (Dvir t981u) — queue #4
**After** Afternic receipt + CR-084. card evidence cache; USPTO TTL 24h. Report when live on `/health`. No money.

# CR-083: card evidence cache (Buyer → Risk Gate; USPTO TTL 24h)

**Approval:** none-needed (maintenance; no money; no settings activation; no founder-rule change). Gavriel authorized filing under JOINT-OPS go (2026-10-27). Build right away. Max **2 rounds**. Report when live on `/health`.

## Why
Buyer and Risk Gate re-scrape the same USPTO / firm-screen facts on one card (JOINT-OPS sin #3). Independence of **judgment** is required; independence of **fetch** is not. FIXED fetch once into DOM; bots re-judge. Without a cache, every card burns duplicate LLM + browser turns.

Reuse existing `/data/tm-kills` for kill **terms**. This CR adds a small **per-card / per-term evidence cache** bots can POST and GET so Risk Gate defaults to cache-fresh reads.

## What already exists (reuse — do not rebuild)
- `POST/GET /data/tm-kills` — append-only kill terms (CR-063 / CR-074). USPTO live search stays **manual on bots** (no `GET /tm/{term}`; no undocumented scrape in DOM).
- Shortlist / prebid already drops SPELL/BRAND/BIGCO/TM_KILL from loaded lists.
- Screening evidence tables exist for screening runs — **do not** overload them for shortlist card flow unless ATs stay simpler that way (your call; contract = ATs).

## Rules
- R-1 **Bot-posted evidence only.** Buyer/Risk Gate POST results of their own USPTO / firm-screen checks. DOM does **not** call USPTO or scrape firm pages in this CR.
- R-2 **Kinds.** Cache rows support at least: `uspto_check` | `firm_screen` (extensible enum OK). Each row: `domain` (or `term` for USPTO), `kind`, `verdict` (`kill`|`clear`|`flag`|`error`|`unknown`), `checked_at` (ISO, Asia/Jerusalem preferred), optional `note`, optional `evidence_ref` (path/URL without PII), optional `raw` object.
- R-3 **TTL for USPTO.** Default **`uspto_ttl_hours = 24`** (JOINT-OPS §9 Q2). `GET` for `uspto_check` returns `fresh: true|false` from `checked_at` vs TTL. Fresh = Risk Gate **must not** re-scrape by default; it still **re-judges**. Re-scrape allowed when: `fresh: false`, kill-list (`/data/tm-kills`) changed since `checked_at`, or Risk Gate Opinion explicitly demands live.
- R-4 **Firm-screen timestamp.** `firm_screen` rows store last fetch time + operator count summary the bot posts. No auto CLEAR/REJECT from DOM.
- R-5 **Append-only / supersede.** Wrong row → new row with `supersedes` (same pattern as tm-kills) or documented equivalent. No silent UPDATE of verdict.
- R-6 **Scopes.** POST: WRITE or bots/data (non-money). GET: READ or WRITE. Never a money route; never changes portfolio prices, listings, bids, or buys.
- R-7 **No judgment automation.** Cache never auto-approves a card, never sets CLEAR, never calls `/buy` or `/auctions/plans`.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-6 pass; no money path; USPTO still bot-side; TTL default 24h. |
| **Stop condition** | Max **2 rounds**. Further gaps = new CR/BUG citing an AT. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1 **POST uspto_check:** bots/WRITE posts `{domain|term, kind:"uspto_check", verdict:"clear", checked_at}` → 201; `GET` returns the row with `fresh: true` when within 24h.
- AT-2 **TTL stale:** same row with `checked_at` older than 24h → `GET` shows `fresh: false` (or equivalent); nothing auto-deleted.
- AT-3 **firm_screen:** POST `kind:"firm_screen"` with operator count + `checked_at` → 201; GET returns it; portfolio/BIN unchanged.
- AT-4 **Append / supersede:** posting a correcting row (supersedes or new) leaves prior row readable for audit; no silent overwrite without audit trail.
- AT-5 **Negative — money:** endpoints are not buy/list/bid/sold; calling them does not create `export_pending`, change BIN/floor/walkaway, or write ledger money rows.
- AT-6 **Negative — no DOM USPTO client:** no new route that queries USPTO / TSDR / undocumented trademark sites from the service (CR-074 park stands).

## Out of scope
- Automating USPTO / EUIPO / TMview lookups inside DOM.
- Auto CLEAR / REJECT / buy from cache hits.
- Afternic Portfolio API sync (separate cut).
- Books sole-write cutover, named READ tokens, bak archive, Sedo T-SELL (§10 — waiting Dvir).
- Changing shortlist hard filters (separate migrate CR).

## Decisions / Questions (≤3)
1. **Storage shape:** new `/data/card-evidence` (or `/data/evidence-cache`) vs extend an existing data table — your call; ATs are the contract.
2. **TTL setting:** default 24h in code is fine; expose as settings version only if cheap — else constant OK for v1.
3. **Kill-list change detection:** "tm-kills changed since checked_at" may be approximate (e.g. any new tm-kills row after checked_at) — document the rule in the release note.

## DVIR items
None.

## Changes
- 2026-10-27 ~03:48 IDT (DOM Architect): Dvir t981u GO AHEAD — queue #4.
- 2026-10-27 ~02:40 IDT (DOM Architect): filed per Gavriel JOINT-OPS go; maintenance FIXED token-saver.

## DOM response (27 Oct 2026, built for 5.64.0, not yet released)
**Verdict: accepted and built.** All six ATs pass as tests `CR083-AT1..AT6` (plus `CEC-1..10`), rules in `docs/internal/card-evidence.md`, contract section "Card evidence cache" in `endpoints.md`.

**Answers to the three questions**
1. Storage: a new append-only table `card_evidence` behind `POST /data/card-evidence`, `GET /data/card-evidence`, `GET /data/card-evidence/{id}`. Screening evidence tables are not touched.
2. TTL: the constant `USPTO_TTL_HOURS = 24` in code; `GET` returns `ttl_hours`. Not a setting in v1.
3. Kill-list change: **approximation**. Any `/data/tm-kills` row added after the row's `checked_at` makes a `uspto_check` `fresh: false` with `stale_reason: "tm_kills_changed"`, whatever the term. Safe direction: a bot only re-scrapes more often.

**How to use it**
- Post: `{"rows":[{"domain":"x.com" or "term":"x","kind":"uspto_check|firm_screen|other","verdict":"kill|clear|flag|error|unknown","checked_at":"2026-10-27T11:30:00+03:00","note":"...","evidence_ref":"path or URL, no @","raw":{...<=8KB},"supersedes":12}]}`, 1..500 rows, `Idempotency-Key`, `dry_run` allowed. The answer lists `ids` for the stored rows.
- Read: `GET /data/card-evidence?domain=x.com&kind=uspto_check`; each row has `fresh` (true/false for uspto_check, null for other kinds), `stale_reason` (`superseded|expired|tm_kills_changed`) and `superseded_by`. `fresh_only=true` hides superseded and stale rows. A `data` token can POST but gets 403 on GET; READ cannot POST.
- Fresh means "do not re-scrape by default"; Risk Gate still re-judges. The cache never approves or rejects a card.
