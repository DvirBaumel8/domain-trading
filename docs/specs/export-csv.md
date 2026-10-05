# GET /export/afternic.csv and GET /export/sedo.csv  (READ)

**Goal:** produce bulk-upload files in exactly the format each marketplace expects. A bot uploads them **by hand on the marketplace website, weekly** (neither marketplace has a seller API we can use; Dvir, 5 Oct 2026, 20:07: bots act on the marketplace sites).

## Afternic (format verified)
Source: the official template `bulk_upload_sample_v3.xlsx`, copied in `templates/`, from https://www.afternic.com/forms/bulk_upload_sample_v3.xlsx.
- **Header, exactly, in this order:**
  `Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden`
- **Rows:** every domain with status `listed` (i.e. a listing mode is set). Sorted by domain. **Always the full current file**: there is no `changed_only` (any query parameter, including that one, is a 422 `VALIDATION_ERROR`); a GET writes only an `export_runs` row (id, snapshot time, names) that the upload confirmation refers to.
- **Cell values depend on the domain's listing mode.** The per-mode table in `listing-strategy.md` §6 is binding; the table below gives the general format rules.

| Column | Value |
|---|---|
| `Domain` | `display_name` if set (CamelCase), else the domain |
| `Buy Now Price` | Integer USD, no `$`, no thousands separator. `0` in offer mode |
| `Floor Price` | Integer USD, or blank |
| `Min Offer` | `min_offer`: in bin mode = BIN; **in hybrid = `hybrid_min_offer` ($100; Dvir, 5 Oct 2026, 01:03 IDT)**, never the walk-away. The walk-away is a private threshold and is **never exported** (`listing-strategy.md` §10.8, test OF-14). **Must be ≥ 20** |
| `Lease to Own` | `Y` only in hybrid with an LTO override (BIN 495–5,000,000; public LTO is off by default); otherwise `N` |
| `Max Lease Period` | `lto_max_months` (2–60), or blank |
| `Sale Lander` | By mode: bin → `Buy It Now`; offer/hybrid → `Custom Lander`. Allowed values: `Request Price`, `Buy It Now`, `Custom Lander`, `Cashparking` |
| `Show Buy Now Option` | bin/hybrid `Y`, offer `N` |
| `Show Lease to Own Option` | `Y` if LTO is on, else `N` |
| `Show Make Offer Option` | offer/hybrid `Y`, **bin `N`** |
| `Hidden` | `N` (for sale through the reseller network) |

- **Sold, delisted or dropped domains are not in the file.** Afternic "Update" doesn't delete listings, so the response header `X-Manual-Delist` lists domains sold, **delisted (the scheduled `drop_date − 7` event)** or dropped since the last confirmed upload: status changed (`listing_changed_at`) after the **snapshot time** (`export_runs.at`) of the venue's newest confirmed upload, and first listed at or before it. A name is cleared by the next confirmed file taken after the change. Dvir removes those by hand.
- **More response headers:**
  - `X-Export-Id` (an id for this file);
  - `X-Pending-Changes` (the count of listed domains whose `listing_changed_at` is after the snapshot time of the venue's newest confirmed upload, or all listed domains if none was confirmed);
  - `X-Export-Warnings`.
- **Confirming an upload:** after the bot uploads a file, Gavriel calls `POST /export/{venue}/uploaded` `{"export_id":"…","uploaded_at":"…","note":"…"}` (WRITE, idempotent). **`approval_ref` is optional** (bot autonomy, 20:07); if sent, it is validated and its time becomes `uploaded_at`. `uploaded_at` (optional, ISO with offset): default now; not in the future; not before the file's `at` (−60 s tolerance) → else 422 **`UPLOADED_AT_INVALID`** (also for a malformed value; an `approval_ref` older than the file → `APPROVAL_INVALID`). `note` (optional): no `@` → else 422 `NO_PII`. The server records an `export_uploads` row (the venue's pending boundary is that file's snapshot time, not `uploaded_at`, so a change made between the download and the upload stays pending) and, for Afternic, clears `export_pending_since` for the file's domains unchanged since the snapshot. `/report` warns `EXPORT_PENDING` until then (error level after 7 days).
- **Never generate a file meant for "Replace"**: Replace deletes every listing that isn't in the file.
- Encoding UTF-8, line ending CRLF, RFC 4180 quoting, `Content-Disposition: attachment; filename="afternic-YYYY-MM-DD.csv"`.

## Sedo (format partly verified)
Fields documented by Sedo: **Domain, Selling Option, For Sale (yes/no), Price, Minimum Price, Currency (USD/EUR/GBP), Action Type**. The uploader takes CSV or XLS(X).
- Sources: https://sedo.com/us/about-us/news-press/newsroom/sedo-releases-new-bulk-domain-uploader/ ; https://sedo.com/services/s_priceoption3.php3?language=e (with a fixed price, a minimum offer isn't allowed).
- **The exact header strings and option values aren't public.** Sedo's "Example file" sits inside the logged-in account.
- **Implementation:** the header row and value map are **configuration**, stored in `templates/sedo_template.json`:
  ```json
  {"headers": ["<exact header 1>", "..."],
   "map": {"domain":"<header>","selling_option":"<header>","for_sale":"<header>","price":"<header>","min_price":"<header>","currency":"<header>","action":"<header>"},
   "values": {"buy_now":"<exact value>","make_offer":"<exact value>","for_sale_yes":"<exact value>","usd":"USD","action_add":"<exact value>"}}
  ```
  Dvir fills this in once, from the downloaded example file.
- **Until the template exists, the endpoint returns 501** `SEDO_TEMPLATE_MISSING`, with instructions. It never guesses.
- **Rows by mode** (`listing-strategy.md` §6; **Sedo is Make Offer for every mode since v2**, Dvir 5 Oct 09:17): bin (geo) → Make Offer + price expectation = BIN + minimum = BIN; offer → Make Offer + minimum = `min_offer`; hybrid → Make Offer + price expectation = BIN + **minimum = `min_offer` ($100)** (default `sedo_hybrid_as=make_offer`; `buy_now` only by admin change); the walk-away is never exported. Currency USD; For Sale yes; Action = add/update. `X-Export-Id` and the upload confirmation work as for Afternic.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| E-1 | Header, byte for byte | Matches the Afternic v3 header string exactly | Any difference |
| E-2 | Fixture with 4 domains (geo bin 399; trend hybrid 4995 + LTO 24 by override; buzzword offer min 500 by override; one sold) | 3 rows matching LX-1/LX-4/LX-2 exactly; sold domain excluded and listed in `X-Manual-Delist` | Wrong rows |
| E-3 | `Min Offer` below 20 in the DB | The domain is skipped and reported in `X-Export-Warnings` (DB validation should prevent this anyway) | A row with < 20 |
| E-4 | Price formatting | `1995`, not `$1,995.00` | Any symbol or separator |
| E-5 | Round trip | Parse the CSV with a strict RFC 4180 parser: 11 columns on every row | Parse error |
| E-6 | Sedo template missing | 501 `SEDO_TEMPLATE_MISSING` | A guessed file |
| E-7 | Sedo with a test template | Headers and values exactly as configured; every row Make Offer (v2): hybrid minimum 100, geo minimum = BIN; no fixed-price rows unless `sedo_hybrid_as=buy_now` (then no Minimum Price) | Mismatch |
| E-8 | Auth | READ ok; no token 401 | Other |
| E-9 | Live (gate G5) | The bot uploads the Afternic file with **Update**. Afternic accepts it with 0 errors, and the listing shows the BIN within 48 h | Rejected, or the price differs |
| E-10 | 3 listed domains, 1 changed by a scheduled drop after the last confirmed file | The full file (3 rows, the dropped name at its new values); `X-Pending-Changes: 1`; after confirming it, 0 (= PR-36) | Other |
| E-11 | `POST /export/afternic/uploaded` with an unknown `export_id` / a READ token / a replay | 404 / 403 / replayed once | Other |
| E-13 | Confirm without `approval_ref`; with `uploaded_at` in the future / before the file; `note` with `@`; with `approval_ref` | 200, `export_uploads.approval_text` null, `uploaded_at` = now (or the value sent) / 422 `UPLOADED_AT_INVALID` / 422 `NO_PII` / 200, approval stored, `uploaded_at` = its time | Other |
| E-14 | Any query parameter on either export (`?changed_only=true`, `?foo=1`) | 422 `VALIDATION_ERROR`, no `export_runs` row | A partial file |
| E-12 | A domain hits its `delist` event | Absent from both files; listed in `X-Manual-Delist` until an upload is confirmed | Still exported |
