# Scoring engine (CR-056)

Binding notes for the `engine` module. Contract: `docs/contract/endpoints.md` "Scoring engine data", `jobs.md` (`engineEndings`). Request and DOM's plan: `docs/requests/CR-056-scoring-engine.md`. Test IDs: EN-*.

## Release plan
- **5.4.0 (data, built):** `POST /engine/sales`, `POST /engine/unsold`, `GET /engine/health` (data counts, endings fill), the daily `engineEndings` step.
- **5.5.0 (model, next):** features (all point-in-time), the TypeScript models (gradient boosting, logistic regression for reasons, price tier), `POST /engine/train`, `GET /engine/train/{id}`, `POST /score`, `engine_models`; `model_version` and the model fields in `/engine/health`.
- **5.6.0 (health):** drift per year and quarter, the bars report, the ablation without the endings, precision at a 1:100 base rate.

## Module
`src/modules/engine/`: `uploads.ts` (row checks, duplicate rules, the transaction), `endings.ts` (`EndingsJob`, `endingsHealth`), `health.ts` (`engineHealth`), `api/engine.ts` (`registerEngine`), `index.ts`. Graph position: `registrars <- listing <- selection <- engine`; ops sits on top and takes the job as `JobRunnerDeps.engineEndingsJob` (wired in `src/app.ts`), so ops does not import engine. Selection, buying and candidates never import it. It uses selection's `rdapBaseFor` and `hostPacer` (the shared per-host pacer: 4 in flight, 250 ms between starts) and `RDAP_FALLBACK_BASES` (.co, .io) from `core/rdap.ts`.

## Data model (migration `1763800000000_v5-4-0.sql`)
| Table | Rows | Rule |
|---|---|---|
| `engine_uploads` | one per call: kind, received / accepted / duplicate / rejected, first 200 rejects (jsonb), by, audit_id | append-only |
| `engine_sales` | domain (.com), `price_cents`, `sale_date`, venue, source, source_url, upload_id | append-only; duplicate = same domain with a `sale_date` within 20 days (`SALE_DEDUPE_DAYS`) of a stored row, also inside one call |
| `engine_unsold` | domain, type (`dropped_after_held`, `registered_unsold`), `observation_date`, `caught_by_catcher` (null = unknown), upload_id | append-only; `UNIQUE (domain, observation_date)` |
| `engine_endings` | name (the part before .com), tld (net, co, org, io, ai), `registered` (null = unanswered), `created_at_registry`, `checked_at`, `http_status`, `reason_code`, `evidence` (host, registrar, expires_at, statuses) | newest row per (name, tld) is current; kept permanently |

Uploads run in one transaction under the advisory lock `engine_upload`, so two uploads never race on the duplicate check. Each row is judged alone (a rejected row never fails the call). The audit log keeps the call's row count, not the rows (`elideRows` in `src/http/audit.ts`). None of the four tables is in the backup export (they are rebuilt from Gavriel's files and RDAP; `backup-coverage.test.ts` records why) and none is in the retention job.

## Endings fill rules
- Pairs = every distinct name of `engine_sales` and `engine_unsold` x 5 endings. Due = never asked, or unanswered and older than 6 hours, or answered more than 30 days ago. Order: never asked first, then oldest `checked_at`. A run asks at most 20,000 pairs and stops at 20 minutes (`ENDINGS_*` constants).
- RDAP only, never DNS. 404 (an RDAP-shaped body) = not registered; 200 = registered, with `created_at` from the RDAP "registration" event; timeout, 5xx, 429 or a refusal = unanswered with a reason code (`TIMEOUT`, `SOURCE_ERROR`, `RATE_LIMITED`). One retry after a 429 whose Retry-After is at most 10 s. A refusal slows the host pacer; five in a row open its breaker and the run stops asking that host.
- Writes: never asked -> insert. Unanswered row asked again -> update that row in place (it holds no answer). Answered row asked again after 30 days -> insert a new row for the new answer; an unanswered re-ask leaves the old answer untouched. No `rdap_lookups` / `screening_evidence` rows are written (about 160,000 asks would be too large for the free plan).

## Point-in-time rules (for parts 2 and 3)
- A feature `net_pit` for a row with `as_of` is true when the newest `engine_endings` row for (name, net) with `checked_at` at any time has `registered` and `created_at_registry` strictly before `as_of`. A registry only shows today's state: a name registered and dropped before the check is invisible, and a creation date after a drop-and-re-register is the new one. That is the accepted bias of the RDAP-only method (no Wayback, no DNS).
- `registered = false` or unanswered gives 0 / null for that ending; training treats unanswered as missing, not as 0.
- Word-trend features use only sales rows with `sale_date` before `as_of`; the test file is the newest full quarter and is frozen with a sha256 before training.
- Part 2 adds `engine_models` (parameters, split hash, metrics, feature list) and reads these tables; part 3 adds drift and the bars. Neither changes the tables above except by new columns or tables.

## Tests
`tests/modules/engine/`: `uploads.test.ts` (EN-1..EN-10), `endings.test.ts` (EN-11..EN-20), and the step order in `tests/modules/ops/jobs*.test.ts`.
