# Optional thin CLI `dt` (v1.1, not required for v1)

A ~150-line wrapper over the HTTP API, so Dvir can type the commands he already uses. **It holds no registrar keys and has no logic of its own**. It reads `DT_API_URL` and `DT_TOKEN` (his own WRITE token) from his shell, builds the JSON body, sends it, and prints the response. Every rule is enforced by the server.

| Command | HTTP call |
|---|---|
| `dt check <domain>` | `GET /check?domain=<domain>` |
| `dt buy <domain> --max 11.50 [--max-2yr 23] --category geo [--bin 399 \| --offer --min-offer N] [--dry-run] --approval "<text>" --approved-at <iso>` | `POST /buy` with `proposed_listing` built as below |
| `dt list <domain> --bin 299` | `POST /list/<domain>` `{"mode":"bin","bin":299}` |
| `dt list <domain> --offer --min-offer 500 [--floor 900]` | `{"mode":"offer","min_offer":500,"floor":900}` |
| `dt list <domain> --bin 4999 --offer --floor 2500 --min-offer 1000 [--lto 24]` | `{"mode":"hybrid",…}` |
| `… --override --reason "<why>"` | `"override":true,"override_reason":"…"` |
| `… --category <c>` | `"category":"<c>"` |
| `… --approval "<text>" --approved-at <iso>` | `"approval_ref":{…}` |
| `… --dry-run` | `"dry_run":true` |
| `dt sold <domain> --venue afternic --price 1995 --commission 299.25 --approval "<text>"` | `POST /sold/<domain>` |
| `dt report [--md]` / `dt portfolio [<domain>]` / `dt export afternic\|sedo` | the GETs |

- **Mode inference:** `--bin` alone → `bin`; `--offer` alone → `offer`; both → `hybrid`. Neither, on `list`, means an NS-only re-point.
- Every POST gets a fresh `Idempotency-Key`. `--key <uuid>` lets Dvir retry with the same one.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| CLI-1 | `dt list x.com --bin 299` | Sends exactly `{"mode":"bin","bin":299}` (respx mock) | Any other body |
| CLI-2 | `--offer --min-offer 500` / `--bin 4999 --offer --floor 2500 --min-offer 1000` | `offer` / `hybrid` bodies as in the table | Wrong mode |
| CLI-3 | A server 422 | The error code and message are printed; exit code 2 | Swallowed |
| CLI-4 | No secrets | The CLI never reads registrar env vars (static grep) | Found |
