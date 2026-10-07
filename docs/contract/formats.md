# Data formats (contract v2.11.1)

All CSV files: UTF-8, **CRLF** line endings, RFC 4180 quoting (a cell with `,`, `"` or a line break is quoted, `"` doubled), a header row first.

## Afternic bulk upload (`GET /export/afternic.csv`)
From Afternic's official template (`templates/afternic_bulk_upload_sample_v3.xlsx`). **Header, exactly:**
```
Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden
```
- **Rows:** every `listed` domain, sorted by domain: always the full current file, for Afternic's **Update** upload (never "Replace", which deletes listings missing from the file). Sold, delisted and dropped names are left out and listed in `X-Manual-Delist` instead, for removal by hand.
- **Cells:** prices are integer USD, no `$`, no separators (cents are dropped, with warning `AFTERNIC_ROUNDS_DOWN`). `Domain` is the `display_name` when it's valid, else the lowercase domain. A row whose min offer is below 20 is skipped (`MIN_OFFER_BELOW_20`).

| Mode | Buy Now Price | Floor Price | Min Offer | Lease to Own | Max Lease Period | Sale Lander | Show Buy Now | Show LTO | Show Make Offer | Hidden |
|---|---|---|---|---|---|---|---|---|---|---|
| `bin` (geo) | BIN | BIN | BIN | N | (blank) | `Buy It Now` | Y | N | N | N |
| `hybrid` | BIN | floor | min offer ($100) | N (Y with an LTO override) | months or (blank) | `Custom Lander` | Y | N (Y with LTO) | Y | N |
| `offer` (override only) | `0` | floor or (blank) | min offer | N | (blank) | `Custom Lander` | N | N | Y | N |

- **The walk-away is never in the file.** Example (hybrid 1995): `PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N`.
- Response headers (`X-Export-Id`, `X-Pending-Changes`, `X-Manual-Delist`, `X-Export-Warnings`): `endpoints.md` §Exports.

## Sedo bulk upload (`GET /export/sedo.csv`)
Sedo's exact header strings and option values aren't public, so they're **configuration**: `templates/sedo_template.json`, filled once from the example file in Dvir's Sedo account.
```json
{"headers": ["<exact header 1>", "..."],
 "map": {"domain":"<header>","selling_option":"<header>","for_sale":"<header>","price":"<header>","min_price":"<header>","currency":"<header>","action":"<header>"},
 "values": {"buy_now":"<value>","make_offer":"<value>","for_sale_yes":"<value>","usd":"USD","action_add":"<value>"}}
```
- **No template → 501 `SEDO_TEMPLATE_MISSING`; a malformed one (bad JSON, `<placeholder>` values, duplicate or unmapped headers) → 501 `SEDO_TEMPLATE_INVALID`.** The service never guesses.
- Columns appear in the template's `headers` order; unmapped headers are blank. `Domain` is always the lowercase domain.
- **Rows by mode** (every Sedo listing is Make Offer, so Afternic holds the only binding price):

| Mode | Selling option | Price | Minimum price |
|---|---|---|---|
| `bin` (geo) | make offer | BIN (non-binding price expectation) | BIN |
| `hybrid` | make offer | BIN | min offer ($100) |
| `hybrid` with the admin setting `sedo_hybrid_as = buy_now` | buy now | BIN | (blank) |
| `offer` | make offer | (blank) | min offer |

  For sale = `for_sale_yes`, currency = `usd`, action = `action_add`. The walk-away is never exported.

## Ledger CSV (`GET /ledger?format=csv`)
`text/csv; charset=utf-8`. **Header, exactly:**
```
date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note
```
- `date` = `YYYY-MM-DD` (IDT day the money moved); `type` ∈ `registration`, `renewal`, `fee`, `commission`, `sale`, `payout_fee`, `refund`, `tool`, `ai`, `adjustment`; `amount_usd` signed with 2 decimals (`-11.08` = money out, `1995.00` = in); empty cells for missing values. Rows in date order. The same filters as the JSON form apply.

## Offers (JSON)
`GET /offers` returns `{offers: [<offer view>], truncated}` and `POST /offers` returns one offer view (shape in `endpoints.md` §Offers). Offers are recorded one at a time with `POST /offers`; there is no CSV import.

## Bodies in and out
- Request bodies are JSON (`Content-Type: application/json`), at most 64 KB.
- Responses are JSON unless stated (`/export/*.csv`, `/ledger?format=csv`, `/report?format=md`).
- A replayed response (`Idempotent-Replayed: true`) has the original status, body and content type.
