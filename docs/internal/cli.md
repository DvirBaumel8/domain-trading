# Command lines: admin, jobs, and the optional `dt` CLI

All admin and job commands are DOM-only; they run locally (production: in a `.env.neon` subshell, `docs/runbook.md`). Exit codes: **2** bad input (prints usage), **1** refusal or error, **0** OK. Every admin write leaves an `audit_log` row with scope `admin`.

## Admin (`npm run admin -- …`)
| Command | What |
|---|---|
| `token create --scope read\|write --name <n>` / `token revoke --id <id>` / `token list` | Bot tokens (printed once; stored as SHA-256). The only way to create a token |
| `pricing-settings new [--from-current] --set k=v … --approval-text "<Dvir's words>" --approval-at <ISO> [--note]` / `pricing-settings show [--version N]` | A new `pricing_settings` version (`listing-strategy.md` §10.1). Never via the API |

**Creating v3 (DOM runs this at the gate; Dvir's words and time go in the approval, citing the 6 Oct 2026 decisions):**
```
npm run admin -- pricing-settings new --set allowed_bins_cents='[29900,39900,49900,78800,108800,148800,198800,248800]' --set nongeo_bin_min_cents=78800 --set nongeo_default_bin_cents=148800 --set lander_exception_bins_cents='[198800,248800]' --set floor_rounding=dollar --set drop_mode=ladder --set drops='[{"after_months":6,"steps":1},{"after_months":18,"steps":1}]' --set geo_drops='[{"after_months":12,"steps":1}]' --set final_push_mode=bin_to_lowest_listed_ge_floor --approval-text "<Dvir's words>" --approval-at <ISO>
```
Array keys (`allowed_bins_cents`, `lander_exception_bins_cents`) take a JSON array of positive integers; `floor_rounding` is `round5` or `dollar`; `drop_mode` is `pct` or `ladder` (going back to `pct` after v3 needs a migration: a version created from a v3 row inherits the price list, and the settings loader refuses `floor_rounding` other than `round5` or lander exceptions outside ladder mode; ladder `drops`/`geo_drops` entries are `{after_months, steps}`).
| `import-domain …` | A hand-bought domain (`report.md` §Import). Since 3.9.0 it needs no comps when `pricing_settings` `comps_min` is 0 (v3); the `--legacy-no-comps` refusal for buys on or after 2026-10-05 stays |
| `resolve-purchase --id <purchase_id> --fail --reason "<text>"` | Closes a purchase stuck in `unknown`/`register_sent` as failed (409 `PURCHASE_FAILED` stored). Since 3.9.0 the **only** way an open purchase is failed (the reconciler never does; `/report` `PURCHASE_UNRESOLVED` points here). Check the registrar account first (Dvir, 10 Oct 2026) |
| `drop-at-first-expiry --domain d --approval-text "<words>" --approval-at <ISO>` | **Gate F** (Dvir, 5 Oct 2026). Needs `renewals_used = 0`, status `owned`/`listed`/`delisted`, an `expiry_date`. Sets `drop_date = expiry_date` (allowed by the DB CHECK). For a **listed** name with a plan, regenerates the schedule from the current values (same anchor, from today; M-rows on or after the new final push → `superseded_by_final_push`; old rows `superseded`; PR-25), starting after the last drop that actually ran, so a due-but-unapplied drop is kept. Prints the new `drop_date` and schedule. Codes: `INVALID_STATE`, `NO_EXPIRY_DATE`, `PLAN_UNAVAILABLE`, `NO_CHANGE`, `MAX_ONE_RENEWAL_USED`; warning `DROP_DATE_IN_PAST` (the next daily run drops it). No undo command exists (open for Dvir) |
| `doctor` | Lists the enabled adapters (never prints keys) |

## Jobs (`npm run job -- …`)
`tick | daily` (the same `JobRunner` and steps as `POST /jobs/run`; audited with scope `job`, method `CLI`; backup skipped with a warning when unconfigured), `price-schedule [--dry-run] [--today D]`, `drop [--dry-run] [--today D]` (names past `drop_date` → `dropped`, planned rows cancelled), `registrar-check [--dry-run]`, `export-backup` (local dev only), `import-backup <dir>` (`backup.md`). A future `--today` only with `--dry-run`.

## Optional thin CLI `dt` (v1.1 proposal; not built)
A ~150-line wrapper so Gavriel can use Dvir's approval wording. No registrar keys, no logic: reads `DT_API_URL` and `DT_TOKEN`, builds the body, prints the response. Every POST gets a fresh `Idempotency-Key` (`--key <uuid>` to retry with the same one).
| Command | HTTP |
|---|---|
| `dt check <d>` | `GET /check?domain=<d>` |
| `dt buy <d> --max 11.50 [--max-2yr 23] --category geo --grade weaker \| --category trend --bin 1995 --comps comps.json --settings-version 2 [--dry-run] --approval "<text>" --approved-at <iso>` | `POST /buy` (calls `GET /pricing/preview` first to fill floor and walk-away) |
| `dt price --category trend --bin 1995 [--grade strong] [--listed-on D] [--drop-date D]` | `GET /pricing/preview` (prints `sell_plan_line`) |
| `dt list <d> --bin 299` / `--bin 1995 --offer` | `POST /list/<d>` `{"mode":"bin","bin":299}` / `{"mode":"hybrid","bin":1995}` |
| `… --floor 1295 --walkaway 950 --exception "<why>"` | `{…,"floor":1295,"walkaway":950,"pricing_exception":true,"pricing_exception_reason":"…"}` |
| `dt list <d> --offer --min-offer 500 [--floor 900] --override --reason "<why>"` | `{"mode":"offer",…}` (override only) |
| `--hold "<why>"` / `--unhold` / `--replan` / `--lto 12` / `--category <c>` / `--override --reason` / `--approval … --approved-at …` / `--dry-run` | `pricing_hold` true/false (+ reason) / `replan:true` / `lto_max_months` / `category` / `override`, `override_reason` / `approval_ref` / `dry_run` |
| `dt offers add <d> <amount> --source afternic [--received-at] [--buyer-type] [--ref]` / `dt offers list [--domain]` / `dt offers outcome <id> <outcome> [--approval …]` | `POST /offers` / `GET /offers` / `POST /offers/{id}/outcome` |
| `dt uploaded afternic\|sedo <export_id>` | `POST /export/<venue>/uploaded` |
| `dt sold <d> --venue afternic --price 1995 --commission 299.25 --ref AFN-1 (--evidence afternic_email --evidence-ref "<Message-ID>" \| --approval "<text>")` | `POST /sold/<d>` |
| `dt report [--md]` / `dt portfolio [<d>]` / `dt export afternic\|sedo` | the GETs |
Mode inference: `--bin` alone → `bin`; `--offer` alone → `offer` (needs `--override`); both → `hybrid`; neither on `list` → NS-only.

## Tests
| ID | Case | Pass |
|---|---|---|
| ~~CLI-1~~ (removed: the `dt` CLI was dropped, gaps G-13) | `dt list x.com --bin 299` | Sends exactly `{"mode":"bin","bin":299}` |
| ~~CLI-2~~ | `--offer --min-offer 500 --override --reason x` / `--bin 1995 --offer` | `offer` / `hybrid` bodies (hybrid sends no floor, walk-away or min offer) |
| ~~CLI-3~~ | A server 422 | Code and message printed; exit 2 |
| ~~CLI-4~~ | No secrets | Never reads registrar env vars (static grep) |
| ADM-1 | `drop-at-first-expiry` on a D-001-like name (listed 2026-10-12, 1995/1295/950, expiry 2027-10-04, drop 2028-10-04), clock 2026-10-20 | `drop_date` 2027-10-04; M6 2027-04-12 1595/1035/760 kept; M18 `superseded_by_final_push`; final push 2027-07-06 1095/1035/760; delist 2027-09-27; old rows `superseded`; admin audit row |
| ADM-2 | `renewals_used = 1`; a sold name; a second run; `--approval-at` in the future | `MAX_ONE_RENEWAL_USED` / state error / `NO_CHANGE` / exit 2; nothing changed |
| ADM-3 | DB CHECK | `drop_date = expiry_date` accepted; `expiry + 2 years` (with `renewals_used = 0`) rejected |
| ADM-4 | No `expiry_date`; a listed name whose plan can't load; expiry past; an unlisted `owned` name; a listed name with M6 due but unapplied | `NO_EXPIRY_DATE` / `PLAN_UNAVAILABLE` (exit 1) / OK + `DROP_DATE_IN_PAST` / `drop_date` set, no rows / the unapplied M6 kept |
