# GET /export/afternic.csv and GET /export/sedo.csv  (READ)

**Goal:** produce bulk-upload files in exactly the format each marketplace expects. Dvir uploads them **by hand, weekly** (neither marketplace has a seller API we can use).

## Afternic (format verified)
Source: the official template `bulk_upload_sample_v3.xlsx`, copied in `templates/`, from https://www.afternic.com/forms/bulk_upload_sample_v3.xlsx.
- **Header, exactly, in this order:**
  `Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden`
- **Rows:** every domain with status `owned` or `listed` and a BIN set. Sorted by domain.

| Column | Value |
|---|---|
| `Domain` | `display_name` if set (CamelCase), else the domain |
| `Buy Now Price` | Integer USD, no `$`, no thousands separator |
| `Floor Price` | Integer USD, or blank |
| `Min Offer` | `min_offer`, else `floor`, else blank. **Must be ≥ 20** |
| `Lease to Own` | `Y` if `lto_max_months` is set **and** BIN is 495–5,000,000; otherwise `N` |
| `Max Lease Period` | `lto_max_months` (2–60), or blank |
| `Sale Lander` | `settings.afternic_sale_lander`, default `Custom Lander`. Allowed values: `Request Price`, `Buy It Now`, `Custom Lander`, `Cashparking` |
| `Show Buy Now Option` | `Y` |
| `Show Lease to Own Option` | `Y` if LTO is on, else `N` |
| `Show Make Offer Option` | `Y` |
| `Hidden` | `N` (for sale through the reseller network) |

- **Sold or dropped domains are not in the file.** Afternic "Update" doesn't delete listings, so the response header `X-Manual-Delist` lists domains sold or dropped since the last export. Dvir removes those by hand.
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
   "values": {"buy_now":"<exact value>","for_sale_yes":"<exact value>","usd":"USD","action_add":"<exact value>"}}
  ```
  Dvir fills this in once, from the downloaded example file.
- **Until the template exists, the endpoint returns 501** `SEDO_TEMPLATE_MISSING`, with instructions. It never guesses.
- **Rows:** Buy Now (fixed price) = BIN; Minimum Price blank; Currency USD; For Sale yes; Action = add/update.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| E-1 | Header, byte for byte | Matches the Afternic v3 header string exactly | Any difference |
| E-2 | Fixture with 3 domains (one with LTO and BIN 1995; one with BIN 300 and LTO requested; one sold) | 2 rows; LTO `Y` / `N` correct; sold domain excluded and listed in `X-Manual-Delist` | Wrong rows |
| E-3 | `Min Offer` below 20 in the DB | The domain is skipped and reported in `X-Export-Warnings` (DB validation should prevent this anyway) | A row with < 20 |
| E-4 | Price formatting | `1995`, not `$1,995.00` | Any symbol or separator |
| E-5 | Round trip | Parse the CSV with a strict RFC 4180 parser: 11 columns on every row | Parse error |
| E-6 | Sedo template missing | 501 `SEDO_TEMPLATE_MISSING` | A guessed file |
| E-7 | Sedo with a test template | Headers and values exactly as configured; no Minimum Price on fixed-price rows | Mismatch |
| E-8 | Auth | READ ok; no token 401 | Other |
| E-9 | Live (gate G5) | Dvir uploads the Afternic file with **Update**. Afternic accepts it with 0 errors, and the listing shows the BIN within 48 h | Rejected, or the price differs |
