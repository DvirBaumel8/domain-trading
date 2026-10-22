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
