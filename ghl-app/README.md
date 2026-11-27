# ghl-app

GoHighLevel Marketplace app: for each installed sub-account, asks AI engines about that business twice a month and shows answers and trend on a page inside HighLevel. Python 3.12, stdlib only, no network in tests.

Run: `python3 app.py --port 8080`. Test: `python -m unittest discover -s tests`.

| File | Job |
|---|---|
| `app.py` | Server, `GET /health`; collects routes from the modules below (`register(routes)`), so a module issue never edits it |
| `config.py` | Every setting from env with safe defaults; `status(feature)` gives `configured` or `not_configured` |
| `oauth.py` | Install and tokens (stub) |
| `store.py` | Storage (stub) |
| `runs.py` | Twice-a-month runs (stub) |
| `page.py` | Page inside HighLevel (stub) |
| `tests/test_base.py` | Health, config, stubs register |
| `ci/ghl-app-tests.yml` | CI job, to be installed under `.github/workflows/` |

New tests go in new files under `tests/`. Deploy: second service in the root `render.yaml` (`ghl-app`, free plan).
