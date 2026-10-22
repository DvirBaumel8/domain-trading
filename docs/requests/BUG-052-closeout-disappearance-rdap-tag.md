---
id: BUG-052
kind: BUG
status: approved
owner_bot: dom-architect
approval: "Gavriel 2026-10-22 (Dvir approved option (a) as a data bug fix)"
priority: P1
depends_on: [CR-074, CR-071, CR-075]
supersedes: []
max_rounds: 2
---
# BUG-052: closeout disappearances are counted as competition without saying whether the name was bought or deleted

## Why
`buildPanel.gone_before_end_n` and the `DISAPPEARED` episodes treat every closeout name that leaves the feed before its `ends_at` the same way. A name that left because it went to redemption or pending delete (an unsold closeout being dropped) is counted the same as one somebody bought. That inflates our "competition" numbers and skews buy decisions. The RDAP service from CR-074 (v5.29.0) and the RDAP status rule already used by `pickproofLabels` are enough to tell the two apart. This is a data fix with no new feature.

## Rules
- R-1 **Tag on disappearance:** when a closeout name (GoDaddy closeouts or a sealed Dynadot closeouts upload) is in the previous parsed day and missing from the latest one before its `ends_at`, store `disappearance_tag` ∈ `bought | deleted | unknown`, `tag_reason`, `rdap_checked_at`, and the RDAP registrar/status read. Use the CR-074 RDAP lookup (cache + daily limit), not a new client.
- R-2 **Rule** (status matching is case- and spacing-insensitive, as in `pickproofLabels`):
  - status has `redemption period` or `pending delete`, or the name is not registered (404) → `deleted`;
  - otherwise, the registrar differs from the registrar stored at first sight (or a registrant/owner change shows in RDAP, e.g. a newer `last changed`/transfer event than first sight) → `bought`;
  - otherwise (same registrar, active status, no owner change), RDAP error, timeout, `LOOKUP_LIMIT` or `registered: null` → `unknown`. Never guess `bought`.
- R-3 **Baseline:** store the registrar (from RDAP or the feed) when a closeout name is first seen, so R-2 can compare. If there is no baseline, a registrar change can't be shown and the tag is `unknown` unless the status rule says `deleted`.
- R-4 **Retry:** an `unknown` caused by an error, timeout or limit is tried again on later runs for up to 7 days, then stays `unknown`. A `bought` or `deleted` tag is final.
- R-5 **Backfill:** one idempotent run over past disappearances still in stored data (panel days, `DISAPPEARED` episodes) tags them by the R-2 rule where RDAP can still be read; the rest stay `unknown`. Summary `{eligible_n, retagged_n, bought_n, deleted_n, unknown_n}`, visible in `GET /jobs/runs`.
- R-6 **Competition numbers split by tag:** `buildPanel` summary adds `gone_bought_n`, `gone_deleted_n`, `gone_unknown_n` (sum = `gone_before_end_n`); the market reads that show disappearance counts (`/market/episodes` rows and any `DISAPPEARED` totals) expose `disappearance_tag`. Existing fields keep their meaning.
- R-7 Lookups share the CR-074 daily limit; on `LOOKUP_LIMIT` the step stops and leaves the rest `unknown` for retry (no crash, step stays ok).

## Acceptance tests (via the API; RDAP mocked where noted)
- AT-1 Mock RDAP status `redemptionPeriod` for a gone closeout name → `disappearance_tag: "deleted"`, `tag_reason` names the status.
- AT-2 Mock RDAP status `pendingDelete` (also `pending delete` spelling) → `deleted`.
- AT-3 Mock registrar changed from the first-sight registrar, status active → `bought`.
- AT-4 (negative) Same registrar, status `active`/`clientTransferProhibited`, no owner change → `unknown`, **not** `bought`.
- AT-5 (negative) Mock RDAP timeout, 5xx and `LOOKUP_LIMIT` → `unknown`, step `ok: true`, no crash, the name is retried next run (R-4).
- AT-6 Backfill on a fixture with 3 tagable + 2 unreadable past disappearances → `retagged_n: 3`, `unknown_n: 2`; a second run changes nothing (idempotent).
- AT-7 `buildPanel` summary has `gone_bought_n + gone_deleted_n + gone_unknown_n == gone_before_end_n`, and `/market/episodes` shows `disappearance_tag` on `DISAPPEARED` rows.

## Out of scope
- Any money action (buy, sell, list, renew) or change to buy rules, scores or the scoring model.
- Any new feature beyond the tagging: no WHOIS, no new outside hosts, no new endpoint unless DOM finds one strictly needed for R-6 (say so in the response).
- Changing CR-074 limits or the `pickproofLabels` rule.

## Questions
- Q1 Does the RDAP read already give a usable registrant/owner-change signal (events), or should R-2 rely on registrar change only? Either is fine; say which.
- Q2 For names with no first-sight registrar (R-3), is there a stored source we can use in the backfill, or do they stay `unknown`?

No ship date asked. Please report when it's live on `/health` (version) with the AT → test mapping. Dvir does no setup steps.

---
## DOM response (22 Oct 2026, 15:15 UTC)

**Verdict:** accepted and built as v5.34.0 (commit `8975a49`, tag `v5.34.0`). I'm pushing after 16:20 UTC, once today's datasave run and the 16:00 seal are done. The tags first appear in the 23 Oct 15:00 UTC datasave run; its `buildPanel` is also the backfill.

**One conflict, resolved by DOM:**
- **R-7 (share the CR-074 daily limit):** not done.
  - That limit is 200 lookups per rolling day and serves the bots' own `/rdap` calls. Internal steps never count against it (CR-074 design).
  - Sharing it would starve both: one day of gone closeouts can be thousands of names.
  - Instead, the tags have their own cap of 1,500 live lookups a run (`settings.disappearance_lookups_max_per_run`, migration only).
  - A 429 from Verisign stops the tagging, and the step stays ok.
  - AT-5's `LOOKUP_LIMIT` case is therefore tested as the cap (`stopped_reason: "CAP"`). Names over the cap stay `unknown` / `NOT_CHECKED` and are picked up next run.
  - Recorded as G-118.

**Answers:**
- **Q1 (owner-change signal):** none usable, so `bought` rests on a registrar change only.
  - Verisign `.com` RDAP is thin: it has no registrant.
  - Its `last changed` event moves on any update (a registrar renewal, a status change).
  - Consequence: a closeout bought by a customer of the same registrar reads `unknown`, never `bought`. That is the usual case: a GoDaddy closeout stays at GoDaddy, and a transfer is locked for 60 days.
  - Expect `bought` to be rare. The split's real value is the `deleted` count.
- **Q2 (no first-sight registrar):** both closeout feeds sell their own expired names, so the feed itself is the baseline.
  - GoDaddy: any GoDaddy-family registrar, Wild West Domains included, counts as the same.
  - Dynadot: Dynadot.
  - If `rdap_cache` holds an answer read before the name left, that registrar is used instead (`baseline_source: "rdap_cache"`).
  - DISAPPEARED market episodes have no feed registrar. Without a cache answer they get `NO_BASELINE`, so they are only ever `deleted` or `unknown`.

**What was built:**
- **The rule (R-2), in order:**
  - 404 → `deleted NOT_REGISTERED`.
  - RDAP error → `unknown <TIMEOUT|SOURCE_ERROR|RATE_LIMITED>`.
  - Redemption / pending delete (the same matcher as `pickproofLabels`, now shared as `dropStatusOf`) → `deleted STATUS:<status>`.
  - Created after the name was last seen → `deleted RE_REGISTERED`. This one was added: the old registration ended.
  - No baseline → `unknown NO_BASELINE`.
  - Registrar outside the baseline → `bought REGISTRAR_CHANGED:<before> -> <now>`.
  - Otherwise → `unknown SAME_REGISTRAR`.
- **Non-.com names:** `unknown TLD_NOT_CHECKED` with no lookup (Verisign serves `.com` only). The closeout pool is `.com` already.
- **R-4 (retries):**
  - `bought` and `deleted` are final.
  - Every `unknown` is checked again once a day until 7 days after its first check, then it is final.
  - This covers `SAME_REGISTRAR` too, so a name that reaches redemption a few days later still becomes `deleted`.
- **R-5 (backfill):** the first run collects every stored day pair (the pool keeps 3 days) and every current DISAPPEARED episode. The insert is idempotent. The summary is in `GET /jobs/runs?job=datasave` → `buildPanel.summary.tags` (`eligible_n`, `retagged_n`, `bought_n`, `deleted_n`, `unknown_n`, …).
- **R-6 (counts):**
  - `buildPanel` adds `gone_bought_n` / `gone_deleted_n` / `gone_unknown_n` (sum = `gone_before_end_n`).
  - It also adds `dynadot` (the same split for the two latest sealed Dynadot closeouts uploads) and `tags`.
  - `GET /market/episodes` adds `disappearance_tag` and `disappearance_tag_reason` per row (null unless DISAPPEARED), and `summary.disappeared_by_tag`.
  - No new endpoint.
  - Episode tags follow the previous run's episodes (`episodes` runs after `buildPanel`), so they lag one day.
- **Storage:** table `disappearances`, rows kept 120 days.

**AT → test** (`tests/modules/ops/disappearances.test.ts`):

| AT | Test |
|---|---|
| AT-1 | BG052-1 |
| AT-2 | BG052-2 |
| AT-3 | BG052-3 |
| AT-4 | BG052-4 |
| AT-5 | BG052-5 |
| AT-6 | BG052-6 |
| AT-7 | BG052-7 |
| extra | BG052-8 (RE_REGISTERED, NO_BASELINE, non-.com) |

The full suite passed (2,838 tests).

**Live check for Gavriel after 23 Oct 15:00 UTC:**
- `GET /jobs/runs?job=datasave`: in `buildPanel`, `gone_bought_n + gone_deleted_n + gone_unknown_n == gone_before_end_n`; `tags.status` is `ok` or `stopped` with `CAP`.
- `GET /market/episodes?rule=DISAPPEARED&limit=20`: every row has `disappearance_tag`.

Release note: `docs/releases/v5.34.0.md`. Nothing for Dvir.

---
## Gavriel check (22 Oct 2026, 19:38 IDT)

- v5.34.0 live on `/health` at about 19:37 IDT (Mac tick after tag `v5.34.0`).
- `GET /market/episodes`: every row carries `disappearance_tag` and `disappearance_tag_reason` (null today); `summary.disappeared_by_tag` = bought 0 / deleted 0 / unknown 0. Expected: the first tagging run is the 23 Oct 15:00 UTC datasave.
- `POST /market/episodes` → 403 (still read-only).
- Latest datasave run (21 Oct) has no `buildPanel.summary.tags` / `gone_*_n` yet, as expected.
- R-7 cap of 1,500 per run instead of the CR-074 limit: accepted. Q1/Q2 answers noted (expect `bought` to be rare; `deleted` is the useful count).
- Next: I re-check the 23 Oct datasave run for `tags` (`eligible_n`, `bought_n`, `deleted_n`, `unknown_n`) and that `gone_bought_n + gone_deleted_n + gone_unknown_n = gone_before_end_n`. No action needed from DOM now.
