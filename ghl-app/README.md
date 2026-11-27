# ghl-app

GoHighLevel Marketplace app: for each installed sub-account, asks AI engines about that business twice a month and shows answers and trend on a page inside HighLevel. Python 3.12, stdlib only, no network in tests.

Run: `python3 app.py` (listens on `0.0.0.0`, port from `PORT`, default 8080). Test: `python -m unittest discover -s tests`.

| File | Job |
|---|---|
| `app.py` | Server, `GET /health`; collects routes from the modules below (`register(routes)`), so a module issue never edits it |
| `config.py` | Every setting from env with safe defaults; `status(feature)` gives `configured` or `not_configured` |
| `oauth.py` | Install and tokens (stub) |
| `store.py` | Storage (stub) |
| `runs.py` | Twice-a-month runs (stub) |
| `page.py` | Page inside HighLevel (stub) |
| `tests/test_base.py` | Health, config, stubs register |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Portable run: app + Postgres |
| `ci/ghl-app-tests.yml` | CI job, to be installed under `.github/workflows/` |

New tests go in new files under `tests/`.  Hosting is undecided: the app is portable (Docker) and does not touch the root `render.yaml`.

## Run with Docker

1. `cp .env.example .env` and fill in the values you have (empty means `not_configured`).
2. `docker compose up -d --build` (app on port 8080, Postgres 16 in the `db` service).
3. `curl localhost:8080/health`.

The database is reached only via `DATABASE_URL` (sqlite file by default for local runs and tests; compose points it at `db`). The later scheduler runs inside the app process: no host cron, disks or services.
