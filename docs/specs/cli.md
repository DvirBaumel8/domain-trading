# Optional thin CLI `dt` (v1.1, not required for v1)

A ~150-line wrapper over the HTTP API, so Dvir can type the commands he already uses. **It holds no registrar keys and has no logic of its own**. It reads `DT_API_URL` and `DT_TOKEN` (his own WRITE token) from his shell, builds the JSON body, sends it, and prints the response. Every rule is enforced by the server.

| Command | HTTP call |
|---|---|
| `dt check <domain>` | `GET /check?domain=<domain>` |
| `dt buy <domain> --max 11.50 [--max-2yr 23] --category geo --grade weaker \| --category trend --bin 1995 --comps comps.json --settings-version 2 [--dry-run] --approval "<text>" --approved-at <iso>` | `POST /buy` with `price_grade`/`proposed_listing` (the CLI first calls `GET /pricing/preview` to fill floor and walk-away), `pricing_evidence` and `expected_settings_version` |
| `dt price --category trend --bin 1995 [--grade strong] [--listed-on D] [--drop-date D]` | `GET /pricing/preview` (prints the `sell_plan_line`) |
| `dt list <domain> --bin 299` | `POST /list/<domain>` `{"mode":"bin","bin":299}` |
| `dt list <domain> --bin 1995 --offer` | `{"mode":"hybrid","bin":1995}` (server computes floor and walk-away; min offer $100) |
| `dt offers add <domain> <amount> --source afternic [--received-at <iso>] [--buyer-type end_user] [--ref <id>]` | `POST /offers` (`listing-strategy.md` §10.11) |
| `dt offers import offers.csv [--dry-run]` / `dt offers list [--domain d]` / `dt offers outcome <id> <outcome> [--approval "<text>" --approved-at <iso>]` | `POST /offers/import` / `GET /offers` / `POST /offers/{id}/outcome` |
| `dt list <domain> --bin 1995 --offer --floor 1295 --walkaway 950 --exception "<why>"` | `{"mode":"hybrid","bin":1995,"floor":1295,"walkaway":950,"pricing_exception":true,…}` |
| `dt list <domain> --offer --min-offer 500 [--floor 900] --override --reason "<why>"` | `{"mode":"offer",…}` (override only) |
| `dt list <domain> --hold "<why>"` / `--unhold` / `--replan` | `pricing_hold` true/false / `replan:true` |
| `dt uploaded afternic\|sedo <export_id>` | `POST /export/<venue>/uploaded` |
| `… --override --reason "<why>"` | `"override":true,"override_reason":"…"` |
| `… --category <c>` | `"category":"<c>"` |
| `… --approval "<text>" --approved-at <iso>` | `"approval_ref":{…}` |
| `… --dry-run` | `"dry_run":true` |
| `dt sold <domain> --venue afternic --price 1995 --commission 299.25 --approval "<text>"` | `POST /sold/<domain>` |
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
