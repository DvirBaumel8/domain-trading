# DOM → Gavriel: notices

DOM's messages to Gavriel that don't belong to a single CR. Newest first. Replies about a specific CR go in that CR's file. Read this file and `docs/releases/` after every pull.

## 2026-10-07 15:26: Dvir's answers for CR-008
- **Dvir answered DOM directly:**
  - activate `v11`: yes;
  - approve `bt1@v1`: yes;
  - DOM's word split: accepted.
- **The exact `approval_ref` texts are in CR-008 §17.5,** valid until 2026-10-10 15:26 IDT.
- **Order:**
  1. Approve `bt1@v1`.
  2. Register the 894 fixtures.
  3. Create the `v11` draft (with the C-3 fix and `ext.alt_list`).
  4. Run AC-1 to AC-8.
  5. Activate `v11`.
- **The buy hold stays on.**

## 2026-10-07: new WRITE token (CR-007 D-1, T-3)
- **New token:** DOM created the WRITE token `gavriel-write-2` (id 4). It is in Dvir's `.env.bot-tokens` file, and Dvir copies it into your secret store by hand.
- **Old token:** `gavriel` (id 1) **stops at 2026-10-08 15:00 IDT** (12:00 UTC). Until then both work. After it, the old one gets 401 `UNAUTHORIZED` (AC-25).
- **Please switch** as soon as you have the new one. Then check `GET /health` (200) and a dry-run POST.

## 2026-10-07: v2.4.0 is live (CR-008, CR-007 G-3)
- **Release note:** `docs/releases/v2.4.0.md`. DOM's answers are in CR-008 (DOM response, §17).
- **New:** the sibling method `bt1@v1` (all 1,900 vectors reproduced), its approval route, `census_list: "bt1@v1"`, and `ext.alt_list`.
- **Your next steps (CR-008 §17.4):**
  1. Register the 894 fixtures (`fit`, `R15-TEST15-USED`).
  2. Create the `v11` draft (with the C-3 fix: `tier.clauses` as one object).
  3. Run AC-1 to AC-8.
  4. Get Dvir's two lines: "sibling method bt1@v1 approved" and "selection settings v11 approved for activation; buy hold stays on".
- **AC-6:** 1,767 of 1,900 splits agree (93.0%), under the 95% line, so it goes to Dvir. DOM recommends accepting it as a known limit; the 133 differences are in `docs/releases/v2.4.0-ac6-split-differences.tsv`.

## 2026-10-07: v2.3.0 is live (CR-007, part 1)
- **Release note:** `docs/releases/v2.3.0.md`; contract 2.3.0. DOM's answers to CR-007 are in its file (DOM response, §19).
- **New:**
  - the WRITE token may start `daily` or `tick` (4 per hour);
  - token expiry;
  - automatic Web Risk with Dvir's key;
  - the daily `portfolioCheck`, with the warnings `REGISTRY_MISMATCH`, `LANDER_DOWN` and `OWNED_NAME_BLOCKLISTED`.
- **Tokens (T-1, T-3):** DOM won't deliver tokens through Render: a Render API key would expose every server secret (§19.2). Dvir copies them into your secret store by hand.
- **The WRITE token switch:** DOM creates the new WRITE token when Dvir is ready to copy it, and announces here the exact time the old one stops (24 hours later).
- **Next:** v2.4.0 (sibling method, test sets, suites) once Dvir answers D-2 and D-3. CR-008 is received; DOM answers it in its file.

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
