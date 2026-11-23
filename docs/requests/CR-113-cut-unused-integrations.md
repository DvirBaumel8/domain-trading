> Status: Approved by Dvir 2026-11-23 10:33 IST (via Gavriel). Amended 10:34 IST: DELETE COMPLETELY (see §0).

# CR-113 — Cut unused integrations (stateless scope)
| Field | Value |
|---|---|
| CR id | CR-113 |
| Series | Follows S1–S8 (CR-105..CR-112, fully stateless) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:35 IST |
| Approved by Dvir | 2026-11-23 10:33 IST, relayed by Gavriel: "cut what can be cut". |
| Priority | P0 (land with or before CR-107/CR-110 so the new code never carries the cut paths) |
| Depends on | none; touches the same files as CR-107, CR-110, CR-111 |
| Max Claude Code rounds | 2 |
| Spend | $0 |


## 0. Amendment 2026-11-23 10:34 IST (Dvir via Gavriel): delete completely
This overrides anything softer below. For Dynadot, Sedo, Spaceship, Name.com, Namecheap, NameSilo, Buffer, Companies House and NameBio paid hooks:
- Delete all code, config, env keys, tests, fixtures, migration references, docs, SOPs, bot-logic and knowledge mentions in this repo.
- No feature flags, no archived copies, no "kept for future", no 410 stubs. The routes are removed; contract v7.0.0 lists them once under "Removed in v7.0.0" with the date, and nothing else.
- Gemini and Wayback: off. If their code exists only for those removed paths, delete it too.
- Only exception (zero loss on money records): owned-state DATA rows in the FileStore (CR-105/CR-106) that record past purchases, listings or sales at a removed venue stay as plain historical data (a venue name string). There's no code that talks to that venue.
- Changelog and release notes of past versions stay as they are (history).

## 1. Business need
DOM is going stateless on Render Free at $0. Every integration we don't use adds code, keys, checks and failure points. Dvir approved removing them. Claude Code only; no CloudAgents. No money actions, no settings activation.

## 2. Rules
- **R-1 Remove (code, config, the daily run, /health checks, env templates, docs):**
  - Dynadot: closeouts, aftermarket, auctions, listing lookups (this also ends the R47 hardneg recheck).
  - Sedo.
  - Spaceship: SellerHub and registrar. Do not add the missing SellerHub keys.
  - Name.com, Namecheap, NameSilo.
  - Buffer.
  - Companies House.
  - Any NameBio paid hooks.
- **R-2 Keep:**
  - Porkbun (registrar).
  - GoDaddy: the 5 daily inventory files plus the $4.99 subscription.
  - Afternic (the only sales venue).
  - The public trademark search (no key).
  - Google Web Risk, on our 5 owned names only.
  - The local 15,228-sale file stays as a static file (no NameBio API).
- **R-3 Stay off:** Gemini and Wayback. Remove them from the daily run and /health. Their code may stay only behind a flag that is off by default, or be removed.
- **R-4 Env and docs:** drop the removed keys from `render.yaml`, `.env.example`/env templates, `docs/DEPLOYMENT.md`, the runbook, `docs/contract/endpoints.md` and the bot docs. Endpoints that served only removed integrations follow the CR-109 pattern: 410 Gone plus a pointer, contract v7.0.0.
- **R-5 NOT approved, do not do:** deleting Sedo listings on the Sedo site, moving D-001 or D-005 to Porkbun, closing any account, or revoking keys at the providers. This CR only removes our code and config.
- **R-6 Money and owned-state records that mention a removed venue** (for example past Sedo listings or Dynadot purchases) stay as history in the FileStore (CR-105/CR-106). Never delete or rewrite them.

## 3. Acceptance tests (pass/fail)
- **AC-1 (amended):** `grep -riE` across the whole repo (src, tests, config, workflows, docs, migrations references), excluding docs/releases, CHANGELOG and docs/requests, for `dynadot|sedo|spaceship|namecom|name\.com|namecheap|namesilo|buffer|companies.?house|namebio` finds nothing except the single contract v7.0.0 'Removed' line. A test asserts this allowlist.
- **AC-2:** `/health` and `/health/ping` list no removed provider. `/health` lists only Porkbun, GoDaddy, Afternic, the trademark search and Web Risk (plus the FileStore).
- **AC-3:** the daily run (CR-110) makes 0 calls to removed providers (mocked HTTP: any call to their hosts fails the test).
- **AC-4:** `render.yaml` and the env templates contain no key for a removed provider. The service boots with only the kept keys set.
- **AC-5:** Web Risk is called only for the 5 owned names (D-001..D-005) per run; a test fails if it's called for any other name.
- **AC-6:** the existing tests for the kept providers still pass. History records from R-6 read back unchanged (sha match).

## 4. Questions
- None blocking. If removing a provider breaks a kept path, say so in the PR. Don't keep the provider.
