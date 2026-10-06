# Exports: GET /export/afternic.csv, GET /export/sedo.csv (READ); POST /export/{venue}/uploaded (WRITE)

Bulk-upload files in exactly the format each marketplace expects. A bot uploads them on the marketplace website, weekly (no seller API exists; bots act on the marketplace sites, Dvir 5 Oct 2026, 20:07). Exact formats: `docs/contract/formats.md`; shapes and codes: `docs/contract/endpoints.md`.

## Rules
- **Afternic** header and per-mode cells: `formats.md` (source: the official `templates/afternic_bulk_upload_sample_v3.xlsx`, from https://www.afternic.com/forms/bulk_upload_sample_v3.xlsx). Allowed Sale Lander values: `Request Price`, `Buy It Now`, `Custom Lander`, `Cashparking`. `Hidden` = `N` (for sale through the network). LTO `Y` only in hybrid with an LTO override (BIN 495–5,000,000; months 2–60).
- **Always the full current file** of every `listed` domain, sorted. Any query parameter (incl. the removed `changed_only`) → 422 `VALIDATION_ERROR`, no `export_runs` row. A GET writes only an `export_runs` row (id, snapshot time = app clock before any read, names) in one repeatable-read transaction.
- **Never generate a file meant for "Replace"** (Replace deletes every listing not in the file).
- **Boundary** = the snapshot time (`export_runs.at`) of the venue's newest **confirmed** upload (not `uploaded_at`: a change between download and upload stays pending).
- **Pending** (`X-Pending-Changes`) = listed names with `listing_changed_at` after the boundary (all listed names while none was confirmed).
- **Manual delist** (`X-Manual-Delist`) = names sold, delisted (the scheduled `drop_date − 7` event) or dropped whose `listing_changed_at` is after the boundary and that were first listed at or before it. Afternic "Update" doesn't delete listings, so a bot removes them by hand; the next confirmed file clears them. A delisted name keeps its change time when later sold or dropped.
- **Confirm** `POST /export/{venue}/uploaded {export_id, uploaded_at?, note?, approval_ref?}`: `approval_ref` optional (if sent and valid its time wins over `uploaded_at`; older than the file → `APPROVAL_INVALID`); `uploaded_at` ISO with offset, default now, not in the future, not before the file's `at` (−60 s tolerance), malformed → 422 `UPLOADED_AT_INVALID`; `note` no `@` (`NO_PII`). Records `export_uploads` (moving the boundary) and for Afternic clears `export_pending_since` for the file's names unchanged since the snapshot. Unknown id → 404 `EXPORT_NOT_FOUND`; twice → 409 `EXPORT_ALREADY_CONFIRMED`. `/report` warns `EXPORT_PENDING` until then (error after 7 days).
- **Caveats (accepted, Dvir 6 Oct 2026):** a `/list` change whose clock time is before a concurrent export's snapshot but commits after its read is counted as exported (Gavriel calls sequentially); the comparisons use app-clock timestamps.
- **Sedo:** fields documented by Sedo: Domain, Selling Option, For Sale, Price, Minimum Price, Currency (USD/EUR/GBP), Action Type (sources: https://sedo.com/us/about-us/news-press/newsroom/sedo-releases-new-bulk-domain-uploader/ ; https://sedo.com/services/s_priceoption3.php3?language=e: a fixed price allows no minimum). The exact strings aren't public: they come from `templates/sedo_template.json`, which Dvir fills from Sedo's example file. Until then **501** `SEDO_TEMPLATE_MISSING`; never guess. Every mode is Make Offer since v2 (geo min = BIN; hybrid min $100); `buy_now` only via the admin setting `sedo_hybrid_as`.
- CSV: UTF-8, CRLF, RFC 4180 quoting, `Content-Disposition: attachment; filename="<venue>-YYYY-MM-DD.csv"`.

## Tests
| ID | Case | Pass |
|---|---|---|
| E-1 | Header | Byte-for-byte the Afternic v3 header |
| E-2 | 4 domains (geo bin 399; trend hybrid 4995 + LTO 24 by override; buzzword offer min 500 by override; one sold) | 3 rows = LX-1 / LX-4 / LX-2; the sold one excluded and in `X-Manual-Delist` |
| E-3 | Min Offer < 20 in the DB | Skipped and reported in `X-Export-Warnings` |
| E-4 | Price format | `1995`, not `$1,995.00` |
| E-5 | Round trip | A strict RFC 4180 parser gets 11 columns on every row |
| E-6 | Sedo template missing | 501 `SEDO_TEMPLATE_MISSING` |
| E-7 | Sedo test template | Headers and values as configured; every row Make Offer (hybrid min 100, geo min = BIN); fixed price only with `sedo_hybrid_as=buy_now` (then no minimum) |
| E-8 | Auth | READ ok; no token 401 |
| E-9 | Live (G5) | The bot's **Update** upload is accepted with 0 errors; the listing shows the BIN within 48 h |
| E-10 | 3 listed, 1 changed by a scheduled drop after the last confirmed file | Full file (3 rows, new values); `X-Pending-Changes: 1`; after confirming, 0 (= PR-36) |
| E-11 | Confirm with an unknown id / a READ token / a replay | 404 / 403 / replayed once |
| E-12 | A name hits its `delist` event | Absent from both files; in `X-Manual-Delist` until a confirmed upload |
| E-13 | Confirm without approval; `uploaded_at` future / before the file; `note` with `@`; with approval | 200, `approval_text` null, `uploaded_at` now or sent / 422 `UPLOADED_AT_INVALID` / 422 `NO_PII` / 200, approval stored, its time used |
| E-14 | Any query parameter (`?changed_only=true`, `?foo=1`) | 422 `VALIDATION_ERROR`, no `export_runs` row |
