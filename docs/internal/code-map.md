# Code map

About 1,650 lines. The app keeps nothing: it reads `data/state.json` at start and asks the outside sources on demand.

| File | Inside |
|---|---|
| `data/state.json` | **The whole state**: domains owned and the money ledger. No private price or approval text |
| `data/access.json` | Who may read: name -> sha256 of the token |
| `src/state.ts` | Its schema and rules (`problems`), what may never change (`rewrites`), the caps `MAX_DOMAINS`, `MAX_PURCHASE_CENTS`, `MAX_SPENT_CENTS`, `MAX_CLOSEOUT_CENTS` |
| `scripts/check-state.ts` | `npm run check-state`, run by CI: the rules, no future date, approval records exist, and the append-only check over git history |
| `src/app.ts`, `src/main.ts`, `src/config.ts` | The app (`/health/ping`, `/health`), the start, the environment |
| `src/books.ts` | `GET /portfolio`, `/portfolio/:domain`, `/ledger`, `/report` |
| `src/budget.ts` | `GET /budget`: the money rules for one candidate |
| `src/prefilter/` | The daily job's logic: `feed.ts` (GoDaddy files), `history.ts` (Wayback, 15 s timeout, reuse of the last 30 days), `run.ts` (gates, rows, last prices) |
| `scripts/prefilter.ts`, `.github/workflows/prefilter.yml` | The job: downloads, writes the log folder; the workflow pushes it to `shadow-log` |
| `docs/requests/kills.txt` | Names the job drops; bots edit it |
| `src/registrars/api.ts`, `check.ts` | `GET /check`: quotes, 60 s cache |
| `src/registrars/porkbun.ts` | The Porkbun price lookup (nothing that buys) |
| `src/registrars/selection.ts`, `registry.ts`, `types.ts` | Which quote wins, the allowed registrars, types |
| `src/sources/api.ts` | `GET /registrar-status`, `/listings`, `/sales`, `/auctions`, `/trademarks/:serial` |
| `src/sources/client.ts` | One outside read and its errors (`SourceError`); micro-units to cents |
| `src/sources/web-risk.ts`, `domain-status.ts`, `afternic.ts`, `auctions.ts`, `tsdr.ts` | One file per source, reads only |
| `src/http/auth.ts`, `errors.ts` | Tokens, limits, the error shape |
| `src/core/` | `money.ts`, `dates.ts`, `rdap.ts`; `src/domain-name.ts` is beside it |
| `ghl-app/` | GoHighLevel Marketplace app (stdlib Python; portable via Docker, not in `render.yaml`): `app.py` server + `/health`, `config.py` env settings (`not_configured` when a key is missing), `Dockerfile`, `docker-compose.yml`, `.env.example`, stub modules `oauth.py`, `store.py`, `runs.py`, `page.py` each with `register(routes)`; tests `tests/`; CI file `ci/ghl-app-tests.yml`; see `ghl-app/README.md` |
| `apify-actors/` | Python Apify actors (not the API): four old ones, `wayback-domain-history`, `broken-link-auditor`, `bulk-pagespeed-checker` (each `src/core.py` logic, `src/runner.py` loop, `src/main.py` Apify adapter, `tests/`), `shared/` (`polite.py` is copied into each actor), `ci/` (workflow files to install by hand), `tests/test_contract.py` (all actors), `tests/test_push_and_usage.py` (push guard, workflow shape, usage job), `tools/sync-store-meta.py`, `tools/bot-text-guard.py`, `tools/apify_guard.py` (allow-lists PRIVATE and LIVE; post-push check: private path = private and unpriced, `--live` = listing and price unchanged), `tools/apify_baseline.py` (live pre-push snapshot), `tools/apify_changed.py` (live Actors changed in a commit), `tools/apify_memory.py` (memory 256, live broken-link-auditor timeout 7200), `tools/apify_usage.py` (daily usage report, GET-only). `ci/` holds `apify-push.yml` (manual private push of the 3 private actors; live rebuild of the 4 public actors, manual or on merge to `main`) and `apify-usage.yml` (daily, branch `apify-usage`); both are installed in `.github/workflows/`, plus staged W1 copies `ci.yml`, `claude.yml`, `claude-code-review.yml`, `avc-tests.yml`, `apify-actors.yml` (`tests/test_ci_staging.py`). Push to Apify only by hand or by `apify-push`, each with Dvir's OK |
| `ai-visibility-check/site/agency.py`, `agency_web.py`, `polar_adapter.py`, `agency-terms.html`, `agency-thanks.html` | Agency report bundles (CR-133, flag `AIVIS_AGENCY`; product ids and links from `AIVIS_AGENCY_PRODUCT_<N>` / `AIVIS_AGENCY_LINK_<N>`, nothing for sale until set): ledger, slots, claim by purchase email (index `bundle_emails/<email_key>.json`, order id optional), runs, logo, daily cap, refunds (`agency.py`); routes, portal, bundle pricing page (`agency_web.py`); the one Polar-shaped file (`polar_adapter.py`). Engine side: `engine/aivis/stored.py` (stored result), `report_pdf.py` (fpdf2 PDF), `report_pro.py` (agency render options). Tests `tests/test_agency_*.py` (`test_agency_settings.py`: env settings; `test_agency_wording.py`: neutral copy; `test_agency_claim_email.py`: claim by email, index, `/agency-thanks` alias), `tests/agency_base.py`, `tests/server_base.py` (the one shared test-server bootstrap, `ServerCase`), `engine/tests/test_agency_render.py`. Contract: `docs/contract/avc-agency.md` |
| `ai-visibility-check/site/answer_index.py`, `site/data/answer-index/*.json` | Public page `GET /ai-answers/<slug>` rendered from one stored JSON file (AI answers collected once by hand, 27 Nov 2026); no AI/search call and no provider import; invalid files are skipped; URL in `sitemap.xml` and `llms.txt` ("AI answer index") via `discovery.answer_index_paths()`. Route in `site/server.py`. Test `tests/test_answer_index.py` |
| `ai-visibility-check/engine/aivis/providers/free_search.py` | Free-check providers (Gemini Google Search, then OpenAI web_search). Gemini is asked to search Google and Google Maps and reply with a plain numbered list, because JSON-only prompts suppress Google Search; OpenAI keeps JSON and its citations come from `web_search_call.action.sources`. Tests `engine/tests/test_free_search.py`, `tests/test_free_search_server.py` |
| `apify-actors/ai-brand-mention-check/` | CR-134, private, no price, not pushed: asks ChatGPT, Gemini and Claude (REST, `httpx`) buyer-style questions with web search on; one row per question and engine; `SUMMARY` in the key-value store. `src/config.py` (model ids, cost estimates, env switches), `prompts.py` (the 8 questions), `matching.py` (deterministic mention rules, bundled `data/common_words.txt`), `extract.py` (extractor guards, list-parser fallback), `providers.py` (the 3 APIs + extractor, 60 s call, one retry, error codes, local fake providers), `runner.py` (input checks, run loop, spend guard, charge limit), `summary.py`, `main.py` (Apify adapter, the one charged `push_data`). Tests `tests/` (A1–A29, offline, fake providers and fake clock). Env and Actor-call exceptions are named in `apify-actors/tests/test_listing.py` |
| `scripts/release.ts` | `npm run release -- X.Y.Z "summary"` |

Tests: `tests/app.test.ts` (every route), `tests/prefilter.test.ts` (the job), `tests/unit/` (state, config, money, rdap, domain names, stateless guard, no AI, no top-up, removed providers), `tests/registrars/`, `tests/contract/version-sync.test.ts`.

| To change | Go to |
|---|---|
| Record a purchase, cost, renewal or sale | `data/state.json` (docs/DEPLOYMENT.md "Record a change") |
| A cap | `src/state.ts` |
| A gate of the pre-filter | `src/prefilter/run.ts`, then `docs/contract/prefilter.md` |
| A route | `src/books.ts` or `src/app.ts`, then `docs/contract/endpoints.md` |
| Who may read | `data/access.json` |
| The pricing rules (by hand) | `docs/internal/pricing.md` |
| Open items | `docs/internal/gaps.md` |
