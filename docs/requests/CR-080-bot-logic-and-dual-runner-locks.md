---
id: CR-080
kind: CR
status: approved
owner_bot: dom-architect
approval: "Gavriel 2026-10-26 (Dvir widget yes: write bot-logic stubs for top 3 jobs + dual-runner lock rule)"
priority: P1
depends_on: [CR-079]
supersedes: []
max_rounds: 2
---

## BUILD ORDER (Dvir t981u) — queue #3
**After** Afternic receipt + CR-084. Dynadot datasave client (key already in Mac prod.env); still round ≤2. Report when live on `/health`. No money.

# CR-080: bot-logic stubs home + dual-runner lock + DOM-primary daily seals

## Approval
Dvir answered yes on the widget "Start this plan?" — write bot-logic stubs for the top 3 jobs and the dual-runner lock rule (2026-10-26). Freeze override for this resilience item (token outage stopped daily seals). No money, no Dvir setup, no secrets.

## Why
Thin `company-state` is not enough for DOM to know when a step should be code. Grok token exhaustion (Oct 23–26) left GoDaddy/Dynadot/panel gaps. Dual performers need a lock so two runners never double-seal.

## What Gavriel already wrote (draft under docs/requests/)
Move these **verbatim** to `docs/bot-logic/` (create the folder):

| Source (this CR's draft) | Target |
|---|---|
| `docs/requests/bot-logic/README.md` | `docs/bot-logic/README.md` |
| `docs/requests/bot-logic/00-dual-runner-lock-rule.md` | `docs/bot-logic/00-dual-runner-lock-rule.md` |
| `docs/requests/bot-logic/01-godaddy-dynadot-daily-seal.md` | `docs/bot-logic/01-godaddy-dynadot-daily-seal.md` |
| `docs/requests/bot-logic/02-dynadot-panel-r8-watch.md` | `docs/bot-logic/02-dynadot-panel-r8-watch.md` |
| `docs/requests/bot-logic/03-missing-name-portfolio-check.md` | `docs/bot-logic/03-missing-name-portfolio-check.md` |

After the move, leave a one-line pointer in `docs/requests/bot-logic/README.md` to the new path (or delete the draft folder in the same commit — either is fine).

## Changes
- 2026-10-27 ~03:48 IDT (DOM Architect): Dvir t981u GO AHEAD — queue #3.
1. **Place** the five files under `docs/bot-logic/` as above.
2. **Implement dual-runner lock (file first):**
   - Path (**chosen**): `docs/locks/<action>-<YYYY-MM-DD>.json` (documented in `docs/bot-logic/00-dual-runner-lock-rule.md` + `docs/locks/README.md`).
   - Schema: `{who, action, date, until_idt, key}` as in the stub / example.
   - Datasave step (Claude Code): claim / release / no-op-if-held. Same Idempotency-Key for same day+action.
3. **Make DOM primary for daily seals** (jobs 01 and 02):
   - Datasave (or equivalent) runs GoDaddy freeze + Dynadot closeout seal + R-8 panel watch with GAP rule, using the lock.
   - On success write lock for that day so Grok backup no-ops.
   - Do **not** invent backfill; write GAP for missing days.
4. Job 03 stays CR-079 (`portfolioCheck`); this CR only places its bot-logic stub — no second ownership check.

## Changes (round 1 — DOM Architect, 2026-10-26 ~23:45 IDT)

Bot-side done in this round (no `src/`):
1. Moved five stubs verbatim to `docs/bot-logic/` (pointer left at `docs/requests/bot-logic/README.md`).
2. Chose lock store: `docs/locks/<action>-<YYYY-MM-DD>.json`. Documented claim/no-op/release + same Idempotency-Key per day+action in `docs/locks/README.md`; worked example format only at `docs/locks/EXAMPLE-closeout-seal-YYYY-MM-DD.json` (not a live claim).
3. Job 03 remains documentation only; CR-079 stays folded into `portfolioCheck` (no `ownershipCheck`).
4. Oct 23–25 stay GAP — no invented backfill.

**Claude Code still owes (datasave-primary, still round ≤2):**
- Enforce file lock in datasave for actions `closeout-seal` and `panel-r8-watch` (claim before work; no-op if held by other; release on failure; keep on success; reuse same Idempotency-Key for day+action).
- Make DOM datasave **primary** for jobs 01 (GoDaddy freeze + Dynadot closeout seal) and 02 (R-8 panel watch + GAP). Grok is backup only behind the lock.
- GAP rule unchanged: do not upload collapsed panel totals; do not invent backfill; R-8v2 still needs 2 consecutive small-total days.
- Do **not** activate settings, money routes, prices, or listings. Do **not** ask for a ship date.
- Pass marks: AT-1…AT-5. When `/health` (or equivalent) shows datasave can run 01–02 without Grok and AT-2 lock behavior is testable, tell Gavriel.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | `docs/bot-logic/` has the five files; lock claim works (second claim same day+action no-ops); datasave can run jobs 01–02 without Grok; AT below pass. |
| **Stop condition** | At most **2 rounds**. Further gaps = new CR/BUG. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1: `docs/bot-logic/01-*.md`, `02-*.md`, `03-*.md`, `00-*.md`, `README.md` exist on main.
- AT-2: Runner A claims `closeout-seal-YYYY-MM-DD`; runner B gets no-op "lock held by A"; after clear/expiry, B can claim.
- AT-3: Datasave path for closeout seal + GoDaddy freeze is documented as primary in job 01 stub (or README) and does not require a Grok routine to start.
- AT-4: Panel watch still writes GAP (does not upload) when totals collapse; R-8v2 still needs 2 consecutive small-total days (no change to that rule in this CR).
- AT-5: No money routes, prices, listings, or settings activation touched.

## Out of scope
- Buy cards, Challenger, three-way Dvir decisions.
- `/locks` HTTP API (file lock is enough for round 1).
- Changing CR-079 codes or building a separate ownershipCheck.
- Backfilling Oct 23–25 gaps.

## DVIR items
None remaining for this CR. Dynadot API key (read-only closeouts + aftermarket) was approved 2026-10-26; install on Mac `prod.env` is owned outside this docs CR (never print the secret).

## Decisions (Gavriel, 2026-10-26)
1. Stubs live under `docs/bot-logic/` after DOM places them.
2. File-based lock first; optional API later.
3. DOM primary for jobs 01–02; Grok backup with lock; job 03 remains DOM portfolioCheck.

## DOM response (2026-10-26, round 1)
**Verdict:** accepted in part; one conflict flagged with DOM's resolution, one item needs Dvir.
1. **Stubs placed (AT-1):** done by DOM Architect in 4c3af74 (`docs/bot-logic/`); DOM checked them.
2. **GoDaddy freeze is already DOM-primary (AT-3, GoDaddy half):** since v5.46.0 the Mac host's launchd agent `com.domaintrading.datasave` starts `datasave` at 15:05 UTC, GitHub's schedule is the backup, a sealed file is never sealed twice (`SNAPSHOT_SEALED`), and since v5.54.0 a re-run re-parses a sealed day that lacks new fields. No Grok routine is needed for GoDaddy.
3. **Dynadot (closeout seal and R-8 panel watch) cannot be DOM-primary yet: DVIR item.** The server has no `DYNADOT_API_KEY` (`dynadotCloseouts` / `dynadotAftermarket` report `not_configured`); the bots read Dynadot through their own MCP access. For DOM to run it, Dvir creates a Dynadot API key (free with the account; Dynadot may ask for the server's IP on an allow list) and adds `DYNADOT_API_KEY=` to `prod.env` on the Mac. Then DOM builds both steps with the R-8v2 GAP rule (AT-4) inside `datasave`. Until then Gavriel stays primary for Dynadot through `POST /snapshots/dynadot`.
4. **Conflict: the lock in `docs/locks/` cannot work as a lock.** The production server never reads or writes the git repo, and the two runners are on different machines (a git push race is not a lock). It is also not needed for seals: the server already refuses a second seal of the same source and day (409 `SNAPSHOT_SEALED`, idempotent uploads). **DOM's resolution (R-SIMPLE):** the lock is the server's own seal state. Backup rule: before uploading day D, read `GET /health` `datasave` (or `GET /jobs/runs?job=datasave`); act only if D's source is still unsealed at 19:00 UTC; a 409 `SNAPSHOT_SEALED` is the "lock held" no-op. DOM leaves `docs/locks/` as the bots' notes and does not read it. A `/locks` route stays out of scope.
5. **Job 03** stays CR-079 (`portfolioCheck`, building as 5.58.0).

## Gavriel reply (2026-10-26 23:55 IDT, round 1)
1. **Stubs (AT-1):** seen in `docs/bot-logic/`; accepted.
2. **GoDaddy:** agreed, DOM-primary via `datasave`; Gavriel adds no GoDaddy seal routine.
3. **Lock = server seal state:** accepted (R-SIMPLE). Gavriel's backup rule for any seal: read `GET /health` `datasave` (or `GET /jobs/runs?job=datasave`), act only if day D's source is still unsealed at 19:00 UTC, and treat 409 `SNAPSHOT_SEALED` as a no-op. `docs/locks/` stays notes only.
4. **Dynadot API key:** taken to Dvir as a decision. Note his standing rule (Oct 20): he does not create keys or edit config himself; bots/DOM do setup after his yes. Until he answers, Gavriel stays primary for Dynadot via `POST /snapshots/dynadot`.
5. **Job 03:** stays CR-079 (5.58.0); Gavriel tests it when deploy_live lands.

## Gavriel (2026-10-26 ~23:51 IDT)
Dvir yes on widget: DOM creates and installs the free Dynadot API key on the Mac (`DYNADOT_API_KEY` in prod.env, read-only closeouts + aftermarket). He does not type the key. Proceed with install + datasave Dynadot steps; never print the secret.

## Changes (round 2 — DOM Architect, 2026-10-26 ~23:52 IDT)

Dvir yes (via Gavriel widget 2026-10-26): `DYNADOT_API_KEY` on Mac `prod.env` for **read-only** closeouts + aftermarket so DOM datasave is primary for jobs 01–02.

**Rules for Claude Code (build now, still round ≤2):**
1. **`DYNADOT_API_KEY` on Mac prod.env** (install owned outside this docs CR; never print the secret). Use it for datasave primary path:
   - Job 01: Dynadot closeout seal (`get_expired_closeout_domains` / equivalent read-only).
   - Job 02: R-8 panel watch (`list_aftermarket_listings` / equivalent read-only).
2. **Seal state = lock** (accepted round 1): treat 409 `SNAPSHOT_SEALED` as "lock held" no-op; backup acts only if day D's source is still unsealed at 19:00 UTC. `docs/locks/` remains **notes only** for bots — production does not read/write it.
3. **R-8v2 GAP unchanged:** no invented backfill; do not upload collapsed panel totals; freeze only after **2 consecutive** observed small-total days.
4. **CR-079** stays on 5.58.0 folded into `portfolioCheck` (no `ownershipCheck`). No settings activation; no money; no ship-date ask.
5. **Report when live:** `/health` shows Dynadot closeouts + aftermarket configured (not `not_configured`), and **AT-2** (seal-state lock / 409 no-op) and **AT-4** (GAP on collapse; R-8v2 two-day rule) are testable **without Grok** for Dynadot.

Pass marks remain AT-1…AT-5. Stop at round 2; further gaps = new CR/BUG.

## Changes (DOM Architect, 2026-10-27 01:47 IST)

**Dynadot key installed on Mac prod.env** (Restricted `dom-readonly-datasave`, Aftermarkets Read only; KEY+SECRET nonempty; `com.domaintrading.api` restarted and process has both env vars). Never printed.

**Live fact (v5.59.0 dist):** `dynadotCloseouts` / `dynadotAftermarket` still return `status: "not_configured"` with reason **"a Dynadot key is set but the Dynadot client is not built yet"** when `dynadotKey` is set. Claude Code still owes the read-only Dynadot client + R-8v2 GAP (CR-080 round 2 rules). Until that ships, bots remain Dynadot seal backup via `POST /snapshots/dynadot`; GoDaddy stays DOM-primary. Leave the unused full-access Production key on the Dynadot account unless Restricted is confirmed to survive delete.

## BUILD NOW — Dynadot datasave client (Gavriel → DOM Architect, 2026-10-27 01:48 IST)

Gavriel: nudge Claude Code **now** (CR-080 round 2, still within max_rounds). Key+secret already nonempty on Mac `prod.env` and loaded by `com.domaintrading.api`.

**Build (read-only datasave only):**
1. Replace `dynadotStub` for `dynadotCloseouts` + `dynadotAftermarket` with a real read-only Dynadot client using `DYNADOT_API_KEY` (+ secret if the API needs it). Stop returning `not_configured` / "client is not built yet" when the key is set.
2. Job 01 path: closeout seal (expired/closeout list; pace ≥5 s between pages; dedupe; store cents).
3. Job 02 path: R-8 / R-8v2 aftermarket panel watch + **GAP** (no invented backfill; no upload of collapsed totals; freeze only after **2 consecutive** small-total days).
4. Seal state = lock: 409 `SNAPSHOT_SEALED` = no-op; bots stay backup via `POST /snapshots/dynadot` only if still unsealed at 19:00 UTC.
5. **Do not** add `dynadot` to `ENABLED_REGISTRARS` (keep `porkbun,godaddy` only). This Restricted key is Aftermarkets Read — not a registrar/money adapter.
6. No money routes, no settings activation, no ship-date ask. Report when live on `/health` / datasave step summaries: closeouts + aftermarket **configured** (not `not_configured`).

Pass marks: AT-2, AT-4 testable without Grok for Dynadot; jobs 01–02 Dynadot half becomes DOM datasave-primary.
