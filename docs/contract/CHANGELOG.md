# Contract changelog

Semver for the API contract (`README.md` §Versioning). Newest first. Each entry links to its release note in `docs/releases/`.

## 7.3.1 (2026-11-24): The pre-filter runs on time; mineunited.com renewal price
Release note: `docs/releases/v7.3.1.md`.
PATCH (CR-117). The daily job tries every hour and works once, after 15:00 UTC (`prefilter.md`). mineunited.com has `renewal_cents` 2393.

## 7.3.0 (2026-11-24): Daily auction pre-filter with a public shadow log; the budget rules in code
Release note: `docs/releases/v7.3.0.md`.
MINOR (CR-117). New read `/budget`. `/portfolio` rows may have `do_not_renew_since` and `renewal_cents`; purchase rows have `source` since 24 Nov 2026. New daily job and shadow log (`prefilter.md`). The closeout pilot of $300 is checked.

## 7.2.0 (2026-11-24): Read-only outside sources: Web Risk, registrar status, Afternic, auction lookup, trademark status
Release note: `docs/releases/v7.2.0.md`.
MINOR (CR-116). `/check` adds `web_risk`; `/health` adds `keys_set`; new reads `/registrar-status`, `/listings`, `/sales`, `/auctions`, `/trademarks/{serial}`; new errors `SOURCE_KEY_MISSING`, `SOURCE_ERROR`.

## 7.1.0 (2026-11-23): readers in data/access.json; redundant docs removed
Release note: `docs/releases/v7.1.0.md`.
MINOR. The readers come from `data/access.json` (name to sha256), not from `API_TOKENS`. No route changed.

## 7.0.0 (2026-11-23): Phase 1: stateless, no database, read only, Render free (Dvir, 23 Nov 2026)
Release note: `docs/releases/v7.0.0.md`.
MAJOR. Kept, read only: `GET /health/ping`, `/health`, `/check`, `/portfolio`, `/portfolio/{domain}`, `/ledger`, `/report` (simpler shapes, see `endpoints.md`). Every other route of 6.x answers 404 `NOT_FOUND`, every write route included. Tokens come from `API_TOKENS` and can only read; the scopes, `Idempotency-Key` and `X-Caller` are gone. New base URL: the Render service.
Unused integrations removed (CR-113).

Older versions: `git show archive-2026-11-23:docs/contract/CHANGELOG.md`.
