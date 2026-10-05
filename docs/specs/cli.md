# Optional thin CLI `dt` (v1.1, not required for v1)

A ~150-line wrapper over the HTTP API, so **Gavriel** can use the command wording Dvir's approvals already use. **Gavriel calls every endpoint; Dvir never calls the API** (5 Oct 2026). **It holds no registrar keys and has no logic of its own**. It reads `DT_API_URL` and `DT_TOKEN` (Gavriel's WRITE token) from the shell, builds the JSON body, sends it, and prints the response. Every rule is enforced by the server.

| Command | HTTP call |
|---|---|
| `dt check <domain>` | `GET /check?domain=<domain>` |
| `dt buy <domain> --max 11.50 [--max-2yr 23] --category geo --grade weaker \| --category trend --bin 1995 --comps comps.json --settings-version 2 [--dry-run] --approval "<text>" --approved-at <iso>` | `POST /buy` with `price_grade`/`proposed_listing` (the CLI first calls `GET /pricing/preview` to fill floor and walk-away), `pricing_evidence` and `expected_settings_version` |
| `dt price --category trend --bin 1995 [--grade strong] [--listed-on D] [--drop-date D]` | `GET /pricing/preview` (prints the `sell_plan_line`) |
| `dt list <domain> --bin 299` | `POST /list/<domain>` `{"mode":"bin","bin":299}` |
| `dt list <domain> --bin 1995 --offer` | `{"mode":"hybrid","bin":1995}` (server computes floor and walk-away; min offer $100) |
| `dt offers add <domain> <amount> --source afternic [--received-at <iso>] [--buyer-type end_user] [--ref <id>]` | `POST /offers` (`listing-strategy.md` §10.11) |
| `dt offers list [--domain d]` / `dt offers outcome <id> <outcome> [--approval "<text>" --approved-at <iso>]` | `GET /offers` / `POST /offers/{id}/outcome` (the `dt offers import` CSV command was removed 6 Oct 2026 (Dvir)) |
| `dt list <domain> --bin 1995 --offer --floor 1295 --walkaway 950 --exception "<why>"` | `{"mode":"hybrid","bin":1995,"floor":1295,"walkaway":950,"pricing_exception":true,…}` |
| `dt list <domain> --offer --min-offer 500 [--floor 900] --override --reason "<why>"` | `{"mode":"offer",…}` (override only) |
| `dt list <domain> --hold "<why>"` / `--unhold` / `--replan` | `pricing_hold` true/false / `replan:true` |
| `dt uploaded afternic\|sedo <export_id>` | `POST /export/<venue>/uploaded` |
| `… --override --reason "<why>"` | `"override":true,"override_reason":"…"` |
| `… --category <c>` | `"category":"<c>"` |
| `… --approval "<text>" --approved-at <iso>` | `"approval_ref":{…}` |
| `… --dry-run` | `"dry_run":true` |
| `dt sold <domain> --venue afternic --price 1995 --commission 299.25 --ref AFN-123456 (--evidence afternic_email --evidence-ref "<Message-ID>" \| --approval "<text>")` | `POST /sold/<domain>` (approval optional; without it `transaction_ref` + `evidence` are required) |
| `dt report [--md]` / `dt portfolio [<domain>]` / `dt export afternic\|sedo` | the GETs |

- **Mode inference:** `--bin` alone → `bin`; `--offer` alone → `offer` (needs `--override`); both → `hybrid`. Neither, on `list`, means an NS-only re-point.
- Every POST gets a fresh `Idempotency-Key`. `--key <uuid>` lets Dvir retry with the same one.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| CLI-1 | `dt list x.com --bin 299` | Sends exactly `{"mode":"bin","bin":299}` (MSW mock) | Any other body |
| CLI-2 | `--offer --min-offer 500 --override --reason x` / `--bin 1995 --offer` | `offer` / `hybrid` bodies as in the table (hybrid sends no floor, walk-away or min offer) | Wrong mode or extra fields |
| CLI-3 | A server 422 | The error code and message are printed; exit code 2 | Swallowed |
| CLI-4 | No secrets | The CLI never reads registrar env vars (static grep) | Found |

## Server-side admin commands (`npm run admin -- …`; not part of `dt`)

| Command | What |
|---|---|
| `npm run admin -- drop-at-first-expiry --domain d --approval-text "<Dvir's words>" --approval-at <ISO>` | **Gate F "drop at first expiry"** (Dvir, 5 Oct 2026). Needs `renewals_used = 0`, status `owned`, `listed` or `delisted`, and an `expiry_date`. Sets `drop_date = expiry_date` (the DB CHECK allows `expiry_date` or `expiry_date + 1 year`; `00-architecture.md` §4). If the domain has a plan, regenerates the schedule from the current values (same anchor, from today; M-rows on or after the new final push → `superseded_by_final_push`; old rows `superseded`; PR-25). Writes an admin audit row with the approval. Prints the new `drop_date` and schedule. **Codes** (spec sync, Dvir, 5 Oct 2026, 21:02; step 4d-1 code): `INVALID_STATE`, `NO_EXPIRY_DATE`, `PLAN_UNAVAILABLE`, `NO_CHANGE`, `MAX_ONE_RENEWAL_USED`; warning `DROP_DATE_IN_PAST` (the next daily run drops it). The schedule is regenerated **only for `listed` names**, starting after the last drop that actually ran, so a due-but-unapplied drop is kept. **Exit codes:** 2 bad input, 1 refusals and errors, 0 OK |
| `npm run job -- drop [--dry-run] [--today YYYY-MM-DD]` | The daily drop job, run by hand: `owned`/`listed`/`delisted` names past `drop_date` → `dropped`; planned rows cancelled. Same exit codes |

| ID | Case | Pass | Fail |
|---|---|---|---|
| ADM-1 | `drop-at-first-expiry` on a D-001-like domain (listed 2026-10-12, hybrid 1995/1295/950, expiry 2027-10-04, drop 2028-10-04), clock 2026-10-20 | `drop_date` 2027-10-04; M6 2027-04-12 1595/1035/760 kept; M18 `superseded_by_final_push`; final push 2027-07-06 1095/1035/760; delist 2027-09-27; old rows `superseded`; admin audit row | Old dates kept, or wrong values |
| ADM-2 | Refusals: `renewals_used = 1`; a sold domain; a second run; `--approval-at` in the future | Refused (`MAX_ONE_RENEWAL_USED` / state error / `NO_CHANGE` / exit 2); nothing changed | Changed |
| ADM-4 | `drop-at-first-expiry`: no `expiry_date`; a listed name whose settings/plan can't be loaded; expiry already past; an `owned` (unlisted) name; a listed name with M6 due but not applied | `NO_EXPIRY_DATE` / `PLAN_UNAVAILABLE` (exit 1) / OK + `DROP_DATE_IN_PAST` / `drop_date` set, no schedule rows / the unapplied M6 row kept | Other |
| ADM-3 | DB CHECK | `drop_date = expiry_date` accepted; `drop_date = expiry_date + 2 years` (with `renewals_used = 0`) rejected | Other |
