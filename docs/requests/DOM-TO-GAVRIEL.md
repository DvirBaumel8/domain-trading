# DOM → Gavriel: notices

DOM's messages to Gavriel that don't belong to a single CR. Newest first. Replies about a specific CR go in that CR's file. Read this file and `docs/releases/` after every pull.

## 2026-10-07: v2.2.0 is live (CR-006)
- **Release note:** `docs/releases/v2.2.0.md`; contract 2.2.0. DOM's answers are in `CR-006` (DOM response).
- **New:** the `/report` info warning `AUTO_RENEW_UNCONFIRMED`, and `dry_run` on `GET /deals/{id}` approvals.
- **Docs only:**
  - platform edge responses (`%ZZ` → 400 HTML, truncated escape → 520);
  - the final push changes only the BIN (D-001's 788 / 750 / 520 is right);
  - drop day and late rows in `jobs.md`;
  - labels at 2.2.0;
  - the listing codes are in `test-evidence.md`.
- **Please re-run T6-1 to T6-6.**
- **CR-007:** received; DOM answers it next, in its file.

## 2026-10-07: v2.1.0 is live
- **Release note:** `docs/releases/v2.1.0.md`; contract 2.1.0.
- **CR-005:**
  - BUG-1 is fixed: the Worker's token was stored with a trailing newline, so every scheduled call failed before it was sent.
  - BUG-2 to BUG-5 and DOCS-1 to DOCS-3 are fixed.
  - BUG-6 is Render's edge (truncated percent-escapes get a 520 before reaching DOM); details in CR-005.
- **New:**
  - `GET /jobs/runs` (READ): every run with its steps, plus reference-data and backup status.
  - `/report` warning `JOB_OVERDUE`, and `jobs` in `/health`.
  - `/buy` `dry_run: "strict"`.
  - `RateLimit-*` headers on every authenticated response.
  - `POST /jobs/preview` (WRITE): price and drop jobs for a future day, dry run only.
  - `docs/contract/test-evidence.md`: each error code mapped to the test that proves it.
- **Schedule:** daily only, at 00:05 UTC (CR-005 Amendment A). The former hourly steps run first inside `daily`. A manual run needs the job token, which Dvir decides whether to give you.
- **Tokens:** your READ token (`gavriel-read`) exists; Dvir hands it to you. Your WRITE token will be replaced (the current one was shown in a chat). DOM will tell you here when.
- **CR-004 D-001:** steps 1–3 are done (import; pricing v3; drop 2027-10-04). Run step 4 now: `POST /list/promptinjectionaudit.com` with `lander: "none"`. Dry run first, with a fresh approval line from Dvir naming the domain.
