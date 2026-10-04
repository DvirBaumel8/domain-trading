# Listing and pricing strategy (modes, guards, marketplace mapping)

**Decision (Dvir, 3 Oct 2026, 19:17 IDT):** the way a name is listed depends on its **category**.
- **Geo names (cash-flow flips):** strict **Buy It Now** in a set range (default $299–$499), with **no negotiation**.
- **Trend, B2B and similar names (high-value holds):** **offer** (make-offer only, no BIN) or **hybrid** (high BIN + make offer + floor/min offer).
- They may **not** be listed as a plain low BIN below a set minimum (default $2,500) unless there is an explicit override **and** Dvir's approval.

Dvir wrote this as CLI commands (`dt list <domain> --bin 299`, `--offer`). The system is an HTTP API, so these map to the body of `POST /list/{domain}` (§4). An optional thin CLI keeps exactly those flags (`cli.md`).

## 1. Categories (stored per domain, set at buy or import)

| `category` | From strategy | Default mode | Guard |
|---|---|---|---|
| `geo` | S2 | `bin` | BIN must be in [`geo_bin_min`, `geo_bin_max`] = **[$299, $499]**, and the mode must be `bin` |
| `trend` | S3 | `hybrid` (or `offer`) | High-value guard |
| `b2b` | S3/S4 B2B service names | `hybrid` | High-value guard |
| `collision` | S4 | `hybrid` | High-value guard |
| `regulation` | S6 | `hybrid` | High-value guard |
| `buzzword` | S5 | `offer` | High-value guard |
| `other` | — | none | General rules only; a warning asks for a real category |

- **Required:** `/buy` and `import-domain` refuse to proceed without a category (422 `CATEGORY_REQUIRED`).
- **Configurable:** `settings.high_value_categories` defaults to `trend, b2b, collision, regulation, buzzword`.
- **Changing it later:** goes through `POST /list` with `category` plus `approval_ref`. Moving a high-value name to `geo` counts as an **override**, because otherwise the guard could be dodged by relabelling.

## 2. Modes

| Mode | Meaning | Price fields | Negotiation |
|---|---|---|---|
| `bin` | Strict Buy It Now | `bin` required. Floor and min offer are forced to equal the BIN, or left empty. No lease-to-own | **None.** Offers below the BIN are not invited, and none can be closed without Dvir |
| `offer` | Make-offer only | No BIN. `min_offer` required (≥ $20). `floor` optional | Yes, every offer goes to Dvir (Gate D), except at or above an Afternic floor if one is set (see the warning in §3) |
| `hybrid` | High BIN + make offer | `bin`, `floor` and `min_offer` all required, with **$20 ≤ `min_offer` ≤ `floor` ≤ `bin`**. Lease-to-own is optional and off by default | Yes |

Lease-to-own is **off in every mode by default**. It can be turned on only in `hybrid`, with an explicit `lto_max_months` (2–60) and a BIN of $495–$5M (an Afternic rule).

## 3. How Afternic and Sedo support each mode (researched 3 Oct 2026)

| # | Fact | Source | Status |
|---|---|---|---|
| A1 | The Afternic **Buy Now** price is binding and optional ("leave zero or blank if not set"). It is required for the **Buy It Now lander**, for the Custom Lander's Buy Now option, and for lease-to-own | Afternic bulk template v3 (`templates/`), field text | Verified |
| A2 | The Afternic **Floor** is binding: "If a broker negotiates a price at or above the floor price, our team will complete the sale ... We will not reach out to you before accepting." **So a floor pre-approves every sale at or above it** | Template; https://www.godaddy.com/help/what-is-list-for-sale-27761 | Verified |
| A3 | The Afternic **Min Offer** is "the lowest amount anyone can submit" and is not binding. It must be ≥ $20; the default is $20 (GoDaddy List for Sale sets it to 65% of the BIN) | Template; GoDaddy help 27761; https://blog.afternic.com/whats-new-august-24/ | Verified |
| A4 | **Make-offer only on Afternic:** with no BIN, the marketplace shows Make Offer, and the Custom Lander can show a Make Offer form (added Aug 2024). The **Request Price** lander also exists | https://blog.afternic.com/whats-new-august-24/ ; namepros thread with an Afternic staff reply (link in `../research/marketplaces.md`) | Verified (blog); forum is third-party |
| A5 | **No BIN means less reach:** Afternic says removing the BIN "may affect the exposure" on its Distribution Network. The Premium (Fast Transfer) Network requires a BIN under $100k. A broker who gets a price request will ask the seller for a BIN and a floor | Afternic staff reply (namepros); template Fast Transfer note; https://blog.afternic.com/whats-new-june-2024/ | Verified (Afternic's own words, posted on a forum) |
| A6 | The Custom Lander has switches for Buy Now, Lease to Own and Make Offer (CSV columns `Show … Option`). They apply **only** when Sale Lander = Custom Lander | Template | Verified |
| A7 | **Can make-offer be fully switched off for a BIN listing across GoDaddy and partner sites?** No documented switch. Buyers can still reach a broker. Our guard is **floor = min offer = BIN**, so nothing below the BIN can close or be submitted. Whether Afternic accepts min offer = BIN | — | **UNVERIFIED.** Check at the first geo upload (test LX-9) |
| A8 | **Afternic has no public seller API** for listings. GoDaddy's Aftermarket API only "remove[s] listings and add[s] expiry listings". Afternic listings are set by **bulk CSV** or the dashboard | https://www.godaddy.com/help/how-do-i-access-domain-related-apis-42424 ; `../research/marketplaces.md` | Verified |
| S1 | **Sedo Buy Now (fixed price)** is binding: the seller must sell to the first buyer at that price. **A minimum offer isn't possible with a fixed price.** Per Sedo's terms, "when available, buyers ... may still submit a binding offer ... below the Buy Now price, which Seller can either accept or ignore" | https://faq-us.sedo.com/app/answers/detail/a_id/748 ; https://sedo.com/services/s_priceoption3.php3?language=e ; https://sedo.com/us/about-us/policies-gmbh/agb-fuer-den-service-marktplatz/ | Verified |
| S2 | **Sedo Make Offer:** a listing with no fixed price defaults to Make Offer. Any price shown is a non-binding "price expectation". A **minimum offer** makes Sedo auto-reject offers below it | Same sources | Verified |
| S3 | Sedo has **no floor** (no broker auto-accept) | Same sources (no such field exists) | Verified by absence; low risk |
| S4 | **SedoMLS** distributes **Buy Now** listings to partner registrars, so a Make Offer listing doesn't get MLS reach | `../research/marketplaces.md` M5 | Verified |
| S5 | Sedo's **API** `DomainInsert`/`DomainEdit` has exactly the mode fields: `forsale`, `price`, `minprice`, `fixedprice` (0/1) and `currency` (1 = USD). But it needs the account **username and password** plus a partner ID and signkey, so it is **not used in v1** (bots hold no credentials) | https://api.sedo.com/apidocs/v1/Basic/functions/sedoapi_DomainInsert.html | Verified |
| S6 | Sedo's **bulk uploader** documents Domain, Selling Option, For Sale, Price, Minimum Price, Currency and Action Type. The **exact header strings and values aren't public** | `export-csv.md` | Partly verified (values UNVERIFIED) |

## 4. API body (`POST /list/{domain}`) and Dvir's CLI wording

| Dvir's wording (`dt list …`) | `POST /list/{domain}` body |
|---|---|
| `dt list austinroofrepair.com --bin 299` | `{"mode":"bin","bin":299}` |
| `dt list promptinjectionaudit.com --offer --min-offer 500` | `{"mode":"offer","min_offer":500}` |
| `dt list promptinjectionaudit.com --bin 1995 --offer --floor 950 --min-offer 950` | `{"mode":"hybrid","bin":1995,"floor":950,"min_offer":950}` |
| `… --lto 24` (hybrid only) | `"lto_max_months":24` |
| `… --override --reason "…"` | `"override":true,"override_reason":"…"` (+ `approval_ref`, required) |
| `… --category trend` | `"category":"trend"` (+ `approval_ref`) |
| `… --dry-run` | `"dry_run":true` (validates and previews the export rows; no changes) |

The API **requires `mode`**. The CLI works it out from the flags: `--bin` alone means `bin`, `--offer` alone means `offer`, and both mean `hybrid`. The API rejects contradictions (e.g. `mode: "offer"` with a `bin`).

All prices are whole USD (cents are allowed but rounded down for Afternic, with a warning). `approval_ref` is **required whenever the mode, a price or the category changes** (Gate B). It is optional when only the nameservers are re-pointed.

## 5. Server validation and guards (in this order; the first failure → 422, plus an audit row)

| # | Rule | Error code |
|---|---|---|
| V1 | `mode` ∈ {bin, offer, hybrid} | `MODE_INVALID` |
| V2 | The domain has a category | `CATEGORY_REQUIRED` |
| V3 | **bin:** `bin` present; `floor` and `min_offer` empty or equal to `bin` (the server stores them = `bin`); no lease-to-own | `BIN_REQUIRED` / `BIN_MODE_NO_NEGOTIATION` / `LTO_NOT_ALLOWED` |
| V4 | **offer:** no `bin`; `min_offer` ≥ 20; `floor`, if given, ≥ `min_offer`; no lease-to-own | `OFFER_MODE_HAS_BIN` / `MIN_OFFER_REQUIRED` / `MIN_OFFER_TOO_LOW` / `FLOOR_BELOW_MIN_OFFER` / `LTO_NOT_ALLOWED` |
| V5 | **hybrid:** `bin`, `floor` and `min_offer` all present, with 20 ≤ `min_offer` ≤ `floor` ≤ `bin`. Lease-to-own only with `lto_max_months` 2–60 and a BIN of $495–$5,000,000 | `HYBRID_FIELDS_REQUIRED` / `HYBRID_PRICES_INVALID` / `LTO_INVALID` |
| V6 | **Geo guard:** if `category = geo`, the mode must be `bin`, **and** `geo_bin_min` ≤ `bin` ≤ `geo_bin_max` (default 299–499) | `GEO_MODE_NOT_ALLOWED` / `GEO_BIN_OUT_OF_RANGE` |
| V7 | **High-value guard:** if the category is in `high_value_categories` and the mode is in `high_value_guard_modes` (default `["bin"]`), then `bin` ≥ `high_value_min_bin` (default **$2,500**) | `HIGH_VALUE_LOW_BIN` |
| V8 | **Override:** V6 and V7 may be passed only with `override: true`, a non-empty `override_reason` **and** a valid `approval_ref` that names the domain and is ≤72 h old. V1–V5 can **never** be overridden | `OVERRIDE_NEEDS_APPROVAL` |
| V9 | Category change: needs `approval_ref`. A high-value → `geo` change also needs `override` | `APPROVAL_REQUIRED` / `OVERRIDE_NEEDS_APPROVAL` |
| V10 | Any change to mode, price or category needs `approval_ref` | `APPROVAL_REQUIRED` |

**Warnings** (200 with `warnings[]`):
- `FLOOR_AUTO_ACCEPT`: "Afternic will close any deal ≥ floor without asking you" (any floor below the BIN).
- `NO_BIN_LESS_EXPOSURE`: offer mode (A5); no Premium or Fast Transfer reach.
- `BIN_OVER_FAST_TRANSFER_MAX`: BIN ≥ $100,000.
- `HYBRID_BIN_BELOW_HIGH_VALUE_MIN`: hybrid with a BIN below $2,500. Allowed, because the guard is about *plain* low BINs. **D-001 triggers this at $1,995.**
- `SEDO_NO_FLOOR`: hybrid on Sedo is Buy Now without a floor (S1/S3).
- `CATEGORY_OTHER`.

**Every accepted change** appends one row to `listing_history` (append-only), with the mode, prices, category, override, reason, approval text and time, `audit_id` and `source` (`buy`/`import`/`list`).

**Settings** (admin command only, never the API):
- `geo_bin_min_cents` 29900
- `geo_bin_max_cents` 49900
- `high_value_categories`
- `high_value_min_bin_cents` 250000
- `high_value_guard_modes` ["bin"]
- `sedo_hybrid_as` (`buy_now` default, or `make_offer`)

## 6. Mode → export columns

**Afternic** (`/export/afternic.csv`; header exactly as `export-csv.md`):

| Mode | Buy Now Price | Floor Price | Min Offer | Lease to Own | Max Lease Period | Sale Lander | Show Buy Now | Show LTO | Show Make Offer | Hidden |
|---|---|---|---|---|---|---|---|---|---|---|
| `bin` | BIN | BIN | BIN | N | (blank) | `Buy It Now` | Y | N | N | N |
| `offer` | `0` (not set, A1) | floor or (blank) | min_offer | N | (blank) | `Custom Lander` | N | N | Y | N |
| `hybrid` | BIN | floor | min_offer | N (Y only if LTO on) | months or (blank) | `Custom Lander` | Y | N (Y if LTO on) | Y | N |

- **Mode switch caveat (UNVERIFIED):** on an Afternic **Update** upload, it isn't documented whether a blank cell clears the old value or keeps it. That's why offer mode writes `0` for the BIN (the template says "zero or blank" = not set). After any mode change, Dvir checks the listing in the Afternic dashboard (LX-8).

**Sedo** (`/export/sedo.csv`; the strings come from Dvir's template map):

| Mode | Selling Option | Price | Minimum Price | For Sale | Currency |
|---|---|---|---|---|---|
| `bin` | Buy Now / fixed | BIN | (blank / 0: not allowed with fixed, S1) | yes | USD |
| `offer` | Make Offer | (blank / 0) | min_offer | yes | USD |
| `hybrid` (`sedo_hybrid_as = buy_now`, default) | Buy Now / fixed | BIN | (blank / 0) | yes | USD |
| `hybrid` (`sedo_hybrid_as = make_offer`) | Make Offer | BIN as a non-binding price expectation | min_offer | yes | USD |

**Why hybrid on Sedo defaults to Buy Now:**
- **Buy Now: 7/10.** It keeps SedoMLS reach (S4), and Sedo still lets buyers send lower offers (S1).
- **Make Offer: 5/10.** It loses MLS, though it does gain a minimum offer.

**Geo on Sedo:** offers below the BIN that Sedo forwards are simply ignored. That is not a reply, so no Gate D is needed.

## 7. Buy-time approval of the sell plan
Every buy card now carries a **"Proposed listing: mode, BIN, floor (min offer)"** line (`system/bot-team.md` §3). Dvir approves the buy and the sell plan in **one** chat message. Gavriel sends `/buy` with `category` and `proposed_listing` (`buy.md`). The server **validates the proposed listing before buying** (V1–V8), so a buy whose sell plan breaks a guard is refused **before any money is spent**.

## 8. D-001 (current state, from Dvir 19:17 IDT)
- `promptinjectionaudit.com` is **OWNED**. Dvir bought it by hand at **GoDaddy** (not Porkbun) on **2026-10-03**. **Price and order number are pending.**
- Category `trend`. Mode `hybrid`. Current plan: **BIN $1,995 / floor $950**. Dvir may raise the BIN.
- Min offer isn't set yet. **Suggestion:** min offer = floor ($950), so no offer below the floor reaches him.
- **Decision for Dvir:** an Afternic floor of $950 means **Afternic can sell at ≥ $950 without asking him** (A2). If he wants to approve every deal below the BIN himself, set **floor = BIN** ($1,995): then nothing below the BIN can close without him, and offers ≥ min offer still reach him (Gate D). This is his choice; the default keeps $950 plus the `FLOOR_AUTO_ACCEPT` warning.
- Expected warnings: `HYBRID_BIN_BELOW_HIGH_VALUE_MIN` (1995 < 2500), `FLOOR_AUTO_ACCEPT`, `SEDO_NO_FLOOR`. Expected errors: none.
- GoDaddy specifics are in `report.md` §Import and `../research/registrars.md`.

## 9. Tests (pass/fail; G0 unit + G1 API)

**Mode validation (LS)**

| ID | Input | Pass | Fail |
|---|---|---|---|
| LS-1 | `mode:"auction"` | 422 `MODE_INVALID` | Accepted |
| LS-2 | bin mode, no `bin` | 422 `BIN_REQUIRED` | Accepted |
| LS-3 | bin 399 + floor 350 | 422 `BIN_MODE_NO_NEGOTIATION` | Accepted |
| LS-4 | bin 399, floor/min_offer omitted | 200; stored floor = min_offer = 399 | Other values |
| LS-5 | bin mode + `lto_max_months` | 422 `LTO_NOT_ALLOWED` | Accepted |
| LS-6 | offer + bin 2000 | 422 `OFFER_MODE_HAS_BIN` | Accepted |
| LS-7 | offer, no min_offer / min_offer 10 | 422 `MIN_OFFER_REQUIRED` / `MIN_OFFER_TOO_LOW` | Accepted |
| LS-8 | offer, min_offer 500, floor 400 | 422 `FLOOR_BELOW_MIN_OFFER` | Accepted |
| LS-9 | offer, min_offer 500 | 200 + `NO_BIN_LESS_EXPOSURE` | No warning |
| LS-10 | hybrid missing floor | 422 `HYBRID_FIELDS_REQUIRED` | Accepted |
| LS-11 | hybrid bin 1995, floor 2100 / min_offer 1000 > floor 950 | 422 `HYBRID_PRICES_INVALID` (both) | Accepted |
| LS-12 | hybrid + LTO 24 with bin 450 / LTO 61 | 422 `LTO_INVALID` | Accepted |
| LS-13 | hybrid bin 4999, floor 2500, min 1000, LTO 24 | 200, `FLOOR_AUTO_ACCEPT` warning | Rejected, or no warning |
| LS-14 | Contradiction: `mode:"bin"` with `"offer":true`-style extra fields | 422 (unknown or contradictory fields are rejected: strict schema) | Silently ignored |

**Guards (LG)**

| ID | Input | Pass | Fail |
|---|---|---|---|
| LG-1 | geo, bin 299 / 499 (both edges) | 200 | Rejected |
| LG-2 | geo, bin 298 / 500 | 422 `GEO_BIN_OUT_OF_RANGE` | Accepted |
| LG-3 | geo, offer or hybrid | 422 `GEO_MODE_NOT_ALLOWED` | Accepted |
| LG-4 | geo bin 650, `override:true` + reason + valid approval_ref | 200; `listing_history.override = true` with reason and approval | Rejected, or override not recorded |
| LG-5 | geo bin 650, override but no approval_ref / approval 73 h old / approval names another domain | 422 `OVERRIDE_NEEDS_APPROVAL` | Accepted |
| LG-6 | trend, bin mode, bin 999 | 422 `HIGH_VALUE_LOW_BIN` | Accepted |
| LG-7 | trend, bin mode, bin 2500 (edge) | 200 | Rejected |
| LG-8 | trend, bin 999 with override + approval | 200, recorded | Rejected |
| LG-9 | trend, hybrid bin 1995 / floor 950 / min 950 (the D-001 plan) | 200 + `HYBRID_BIN_BELOW_HIGH_VALUE_MIN` + `FLOOR_AUTO_ACCEPT` | Rejected, or warnings missing |
| LG-10 | Setting `high_value_guard_modes=["bin","hybrid"]` then LG-9 | 422 `HIGH_VALUE_LOW_BIN` | Accepted |
| LG-11 | Relabel trick: change category trend→geo without override | 422 `OVERRIDE_NEEDS_APPROVAL` | Accepted |
| LG-12 | Settings via the API (`geo_bin_max` in the body) | Ignored or 422; the setting is unchanged | Changed |
| LG-13 | Price change without `approval_ref` | 422 `APPROVAL_REQUIRED` | Accepted |
| LG-14 | NS-only re-point without `approval_ref` | 200 | Rejected |
| LG-15 | Overrides can't bypass V1–V5 (e.g. hybrid with floor > bin + override) | 422 `HYBRID_PRICES_INVALID` | Accepted |
| LG-16 | `/buy` with `proposed_listing` that breaks V6/V7 | 422 **before** any registrar call (mock shows 0 `register` calls) | Domain bought |
| LG-17 | `/buy` without `category` | 422 `CATEGORY_REQUIRED`, 0 registrar calls | Bought |

**History and audit (LH)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| LH-1 | 3 accepted changes (hybrid → raise BIN → offer) | 3 `listing_history` rows, in order, each with `audit_id`; `/portfolio/{d}` shows them | Missing or out of order |
| LH-2 | Rejected change | 0 history rows, 1 audit row | A history row |
| LH-3 | `UPDATE`/`DELETE` on `listing_history` | DB error | Succeeds |
| LH-4 | `dry_run:true` | 0 history rows; response previews the Afternic and Sedo rows | Rows written |

**Export columns per mode (LX)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| LX-1 | bin mode, BIN 399 | Afternic row = `…,399,399,399,N,,Buy It Now,Y,N,N,N` | Any cell differs |
| LX-2 | offer mode, min 500, no floor | `…,0,,500,N,,Custom Lander,N,N,Y,N` | Differs |
| LX-3 | hybrid 1995/950/950, no LTO | `…,1995,950,950,N,,Custom Lander,Y,N,Y,N` | Differs |
| LX-4 | hybrid + LTO 24, BIN 4999 | `Lease to Own=Y`, `Max Lease Period=24`, `Show LTO=Y` | Differs |
| LX-5 | Sedo, test template, each mode | bin → fixed + price + no min; offer → make offer + min; hybrid (default) → fixed + BIN + no min; hybrid (`make_offer`) → make offer + price + min | Differs |
| LX-6 | Min Offer < 20 ever exported | Never (DB CHECK + V4/V5) | Exported |
| LX-7 | Mode switch hybrid → offer, then export | BIN cell is `0`, not blank | Blank |
| LX-8 | **Live (G5):** first upload per mode | Afternic dashboard shows the expected BIN / floor / min offer / lander for that mode within 48 h (Dvir's screenshot) | Differs → fix the mapping; record the finding in `../research/marketplaces.md` |
| LX-9 | **Live (G5), first geo name:** Min Offer = BIN accepted by Afternic | Accepted, with no offer form on the lander | Rejected → fallback min offer = 0.9 × BIN, documented; re-run LX-1 with the new rule |
