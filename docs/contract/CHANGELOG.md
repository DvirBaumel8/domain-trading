# Contract changelog

Semver for the API contract (`README.md` §Versioning). Newest first. Each entry links to its release note in `docs/releases/`.

## 7.1.0 (2026-11-23): readers in data/access.json; redundant docs removed
Release note: `docs/releases/v7.1.0.md`.
MINOR. The readers come from `data/access.json` (name to sha256), not from `API_TOKENS`. No route changed.

## 7.0.0 (2026-11-23): Phase 1: stateless, no database, read only, Render free (Dvir, 23 Nov 2026)
Release note: `docs/releases/v7.0.0.md`.
MAJOR. Kept, read only: `GET /health/ping`, `/health`, `/check`, `/portfolio`, `/portfolio/{domain}`, `/ledger`, `/report` (simpler shapes, see `endpoints.md`). Every other route of 6.x answers 404 `NOT_FOUND`, every write route included. Tokens come from `API_TOKENS` and can only read; the scopes, `Idempotency-Key` and `X-Caller` are gone. New base URL: the Render service.
Unused integrations removed (CR-113).

Older versions: `git show archive-2026-11-23:docs/contract/CHANGELOG.md`.
