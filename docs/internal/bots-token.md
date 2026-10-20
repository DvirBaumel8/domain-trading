# Shared bots token (CR-069, v5.20.0)

Binding rules and test IDs. Code: `src/http/auth.ts` (`BOTS_ROUTES`, `registerScope`), `src/modules/ops/api/tokens.ts` (`registerTokens`), `src/http/idempotency.ts` (`idemReplayBody`), `src/http/audit.ts` (`botNameOf`). Contract: `docs/contract/README.md` (Who may call) and `endpoints.md` (`POST /tokens/bots/rotate`).

## Rules
1. **One key for all the Grok bots, no money.** Scope `bots` (migration `1765100000000_v5-20-0.sql`) may do every GET, every route a data or intake token may call, the visits routes except `POST /visits/hit`, and every mutating route classified `allowed`. A route classified `money` works only when the JSON body has `dry_run: true`; otherwise 403 `SCOPE_FORBIDDEN`. `POST /jobs/run` stays WRITE-only (a bots token gets the usual 401).
2. **Every mutating route is classified** in the one exported table `BOTS_ROUTES` (`allowed` | `money` | `write_only`); a route missing from the table counts as `money`, and the guard test B520-8 fails when a registered mutating route (from `/openapi.json`) is not in the table or the table lists a route that does not exist. A new route therefore cannot reach bots by accident. **When unsure, classify as `money`.** Money routes: `/buy`, `/portfolio/import`, `/list/{domain}`, `/listings/{domain}/venue`, `/export/{venue}/uploaded`, `/offers`, `/offers/{id}/outcome`, `/sold/{domain}`, `/portfolio/{domain}/horizon`, `/engine/holdout-date`, `/quotes/manual`, `/reviews/run`, `/reviews/settings`, `/selection/settings/{label}/activate`, `/selection/sibling-methods/{method}/approve`. Tranches, screening, selection drafts, `/visits/settings`, `/visits/forward/{domain}` and the rest are `allowed`; a real `/buy` is still impossible for a bots token, so an open tranche gives it nothing.
3. **Rotation** is `POST /tokens/bots/rotate` (WRITE or bots caller). It is the one token-creation route and can only make a `bots` token named `bots-shared` (CLAUDE.md "Don't" exception, Dvir 20 Oct 2026, CR-069). The live `bots-shared` token is renamed `bots-shared-old-<id>` (active token names are unique) and gets `expires_at = now + 10 min` (never later than it already had); the auth hook already treats an expired token as unknown (401).
4. **The raw value is shown once.** The 200 body holds it; the idempotency store keeps instead a replay body with `token: null` (`req.idemReplayBody`, set by the handler and used by the idempotency `onSend`), so a replayed key never re-sends a secret and no row holds it. The audit row has no body for this route and only the summary "rotated the shared bots token (old tokens expiring: n)". The database holds only the sha256.
5. **`X-Bot-Name`** (optional header): trimmed, 1..40 characters of `[A-Za-z0-9 _.-]`, else ignored; stored in `audit_log.bot_name` and shown by `GET /audit`. Not a security check.
6. **Retirement of the old tokens** (per-bot READ tokens, `data-engineer-upload`) is a later migration, after Gavriel confirms the shared token works. Nothing is revoked in 5.20.0.

## Test IDs
Tests: `tests/modules/http/bots-scope.test.ts`.

| ID | What |
|---|---|
| B520-1 | GETs and a data upload with a bots token |
| B520-2 | money routes 403 `SCOPE_FORBIDDEN` (also `dry_run` false / `strict`); `/jobs/run` 401 |
| B520-3 | `/buy` with `dry_run: true` passes the scope and writes no purchase |
| B520-4 | rotation: token in no audit_log / idempotency_keys row, replay answers `token: null` |
| B520-5 | new token works, old works at +9 min, 401 at +11 min; self-rotation |
| B520-6 | `X-Bot-Name` in the audit row, invalid or long names ignored |
| B520-7 | READ cannot rotate; bots cannot call `/visits/hit` |
| B520-8 | every mutating route is classified (guard) |

Related (BUG-047, BUG-046): L520-1 (`tests/modules/ops/health.test.ts`: `jobs` overdue by a stale tick, `jobs_last`), L520-2 (`tests/modules/ops/renewal-price.test.ts`: `POST /portfolio/{domain}/renewal-price`), V520-1 (`tests/modules/visits/token-handoff.test.ts`: the migration drops the test hits of 2026-10-19).

v5.20.1 (CR-069 item 5): migration `1765200000000_v5-20-1.sql` revokes the five per-bot READ tokens and `data-engineer-upload`; V5201-2 (`tests/modules/listing/mineunited-fix.test.ts`) checks that only those six are revoked.
