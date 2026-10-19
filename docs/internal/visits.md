# Visitor counter (CR-068, v5.18.0)

Binding rules and test IDs. Code: `src/modules/visits/` (`store.ts`, `forward.ts`, `api/visits.ts`), the counting redirect in `api-proxy/src/index.ts`, the token hand-off in `src/modules/ops/admin/visits-token.ts` and `scripts/local-host/visits-token.sh`. Contract: `docs/contract/endpoints.md` "Visitor counter".

## Rules
1. **Counts only.** `visit_daily` holds one row per (domain, UTC day, source `dom_redirect` | `afternic`): `human_hits`, `bot_hits`, `capped`, `referrer_hosts` (host -> n) and, for the Afternic source, `views_30d` / `leads_30d`. No IP (raw or hashed), cookie, path, query or user-agent string is received, kept or logged. The body of `POST /visits/hit` is strict: `{domain, ua_class, referrer_host?}`.
2. **On since 5.19.0** (Dvir, 19 Oct 2026: no further lines for an approved CR; the migration turns it on and requests the token; `approval_ref` on `/visits/settings` and `/visits/forward` is optional and ignored). *Before 5.19.0: off until Dvir's line.* `settings.visits_enabled` is false by default; `POST /visits/hit` is then 409 `VISITS_DISABLED` and stores nothing. Switched only by `POST /visits/settings` (WRITE, `approval_ref` containing "visits").
3. **Scope `visits`** may call only `POST /visits/hit`; no other scope may call it (`src/http/auth.ts` `registerScope`). Its token has its own limit (600 a minute), so a bot burst does not eat the general 10 a minute.
4. **No per-hit audit row.** `POST /visits/hit` still needs an `Idempotency-Key` (kept 30 days by the idempotency prune) but is excluded from `audit_log` (`UNAUDITED_POSTS` in `src/http/audit.ts`): one row per redirected visitor would be the bulk of the log, and `visit_daily` is the record. Every other `/visits` write is audited.
5. **Only listed names with an active forward** (5.19.1, BUG-046). A hit is counted only for a domain with status `listed` that has an active `visit_forwards` row (set by `POST /visits/forward`, not reverted). The stored `lander_ns` is not used for hits; it was stale for the three Porkbun names. Anything else is 422 `DOMAIN_NOT_LISTED`, logged on the host as `visits hit refused` with the code and domain only.
6. **Cap and referrers.** 1,000 hits (human + bot) per name per UTC day; further hits only add to `capped`. The first 10 distinct referrer hosts of a day keep their own key, the rest add to `other`. One `INSERT .. ON CONFLICT DO UPDATE` statement, so concurrent hits are exact. Referrer values are reduced to a lowercase host; anything else is `other`.
7. **Retention.** `visit_daily` rows older than 400 days are deleted by the retention job (`ops/jobs/retention.ts`, same age in tight mode).
8. **The forward** (`POST /visits/forward/{domain}`) changes only the root and `www` URL forwards of a listed Porkbun name that is not on Afternic NS, to `{PUBLIC_BASE_URL}/r/{domain}` (302, wildcard as before, path not appended) or back to the Afternic page (`revert`). `approval_ref` names the domain and "visits". Never nameservers or DNS records. `PUBLIC_BASE_URL` still at its Render default = 422 `PUBLIC_BASE_URL_UNSET`.
9. **The redirect never depends on DOM.** The Worker answers 302 first; the count is sent afterwards with a 3 s timeout and every error swallowed. No `VISITS_TOKEN` secret = redirect only.
10. **The token reaches the Worker without a person seeing it.** `POST /visits/settings {token: "request"}` (approval text contains "visits token") sets `settings.visits_token_request` = `requested`. The host kit (`visits-token.sh`, called by `deploy.sh` every tick) runs `admin visits-token-handoff`, which revokes older `visit-counter` tokens, creates a `visits` token and prints only the raw token; the script pipes it to `gh secret set VISIT_COUNTER_TOKEN`, starts `deploy-api-proxy` (which sets the Worker secret `VISITS_TOKEN`) and runs `--done`. On a `gh` failure `--failed` revokes the new token and the request stays open. DOM never reads the token or the host env file.
11. **Weekly view.** Week = Sunday..Saturday UTC, `week_ending` must be a Saturday. Listed names that are on Afternic NS (`afternic_ns`) or have no active forward (`not_forwarded`) are `not_countable`, with the newest imported Afternic Views/Leads.

## Test IDs
Tests: `tests/modules/visits/visits.test.ts`, `tests/modules/visits/token-handoff.test.ts`, `api-proxy/src/index.test.ts` (counting redirect).

| ID | What |
|---|---|
| V518-1 | AT-1: disabled = 409 and nothing stored; the settings line must name "visits" |
| V518-2 | AT-3: 3 human + 2 bot hits read back from `GET /visits` |
| V518-3 | AT-4: unlisted, delisted and Afternic-NS names 422 `DOMAIN_NOT_LISTED`; extra key 422 |
| V518-4 | AT-5: referrer reduced to a host; no path, query, port or user agent in any table |
| V518-5 | AT-8: the 1,001st hit adds to `capped` only |
| V518-6 | concurrent hits lose nothing; referrer top 10 then `other` |
| V518-7 | AT-9: scope rules both ways |
| V518-8 | Idempotency-Key required, replay counts once, no audit row per hit |
| V518-9 | `/visits/import`: replace, scopes, unknown name |
| V518-10 | AT-7: weekly rows and `not_countable` |
| V518-11 | weekly needs a Saturday; range limits |
| V518-12 | retention at 400 days |
| V518-13 | forward: dry run and real call against the Porkbun mock |
| V518-14 | forward revert |
| V518-15 | forward refusals |
| V518-16 | `{token: "request"}` (no approval since 5.19.0) and state |
| V519-1 | 5.19.0 migration: counter on by default, token requested |
| V519-2 | BUG-045: live NS decides Afternic NS for forward and weekly |
| V519-3 | BUG-046: a hit counts only with an active forward |
| V518-17 | `visits-token-handoff`: nothing requested = exit 3 and no output; a request = only the raw token |
| V518-18 | `--done` and `--failed` |

The Worker's own tests are named "counting redirect /r/<domain>" in `api-proxy/src/index.test.ts` (they run in the `api-proxy` workflow, not in the root suite).
