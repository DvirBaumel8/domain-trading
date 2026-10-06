# GET /check (READ)

Availability plus **live** prices from every enabled registrar, compared on **first year + exactly one renewal**. Shape: `docs/contract/endpoints.md`.

## Behaviour
1. Normalise: lowercase, trim, drop a trailing dot; a second-level `.com` name only (`TLD_NOT_SUPPORTED`, `DOMAIN_INVALID`, both 422).
2. RDAP `https://rdap.verisign.com/com/v1/domain/<d>`: 404 = `not_registered`, 200 = `registered`, anything else = `rdap_unknown`.
3. Quote every enabled adapter in parallel, 8 s each; an adapter error excludes that registrar only, with the reason.
4. `two_year_cents = first_year + renewal + 2 × privacy_per_year` (paid privacy only). **Never more than one renewal.** GoDaddy (if ever a quote source) uses the standard manual-renewal rate, since auto-renew stays off.
5. Exclusions (`../research/registrars.md`): `NO_CUSTOM_NAMESERVERS` (Cloudflare: always excluded), `NO_AVAILABILITY_ACCESS` (management-only adapter, e.g. GoDaddy < 50 domains), `REGISTRAR_NOT_ALLOWED` (not in `settings.allowed_registrars`), `ADAPTER_ERROR` (+ `error_code`), `NOT_AVAILABLE`, `PREMIUM`, `NOT_USD`, `MULTI_YEAR_MINIMUM` (founder rule 3), `NO_FIRST_YEAR_PRICE`, `NO_RENEWAL_PRICE`. The first three are known before quoting, so those adapters aren't called.
6. Winner = lowest `two_year` among eligible quotes; ties: prepaid model, then Afternic Fast Transfer verified, then adapter order `porkbun > dynadot > namecom > others`.
7. Availability: **any disagreement → `unknown`, no winner** (adapters disagree, RDAP 200 vs an adapter "available", RDAP 404 vs an adapter "not available"). Else `taken` if RDAP 200 or any adapter says not available; `available` if RDAP 404 and ≥ 1 adapter says available; else `unknown`. Only `available` shows a winner.
8. Store every quote (`quotes`) under a new `check_id`.
9. Cache 60 s per domain (Porkbun allows 10 checks / 10 s); a cached answer is replayed whole (same `check_id`). `/buy`'s live re-check bypasses and doesn't write the cache.
- Warning when the cheapest first year isn't the cheapest over 2 years. Unknown query parameters are ignored (not strict; `gaps.md`).
- **Selection checks (v9.1, not built; CR-001):** `POST /check/batch` (RDAP only, SEL-2), `POST /check/history` (CDX + SURBL + Web Risk, blocking, HIST-1; SEL-3, SEL9-14), `GET /check/quote` (the quote used by `/score` and the live renewal price for `GET /renewal/decision`; SEL9-10), `POST /check/tm` (USPTO + control phrase, SEL-4). Bots never call RDAP, CDX, SURBL or NameBio themselves. DOM's position on undocumented sources (Transparency Report, USPTO's search backend): `MANUAL_REQUIRED` until an official API (CR-001 §11).

## Tests
| ID | Case | Pass |
|---|---|---|
| CK-1 | A $5.00 + $25.00 renewal; B $11.08 + $11.08 | Winner B ($22.16); warning names A |
| CK-2 | A Cloudflare-type adapter is cheapest | Excluded `NO_CUSTOM_NAMESERVERS`; next one wins |
| CK-3 | Paid privacy $3/yr | +$6 to `two_year` |
| CK-4 | Premium quote | Excluded `PREMIUM` |
| CK-5 | One adapter times out | Excluded `ADAPTER_ERROR`; others compared; 200 |
| CK-6 | RDAP 200, adapter says available | `unknown`, no winner |
| CK-7 | Missing renewal price | Excluded `NO_RENEWAL_PRICE` |
| CK-8 | Exact tie | Tie-break applied deterministically |
| CK-9 | Two-year rule on 20 random fixtures | first year + **1** renewal |
| CK-10 | `.net` | 422 `TLD_NOT_SUPPORTED` |
| CK-11 | READ token / no token | 200 / 401 |
| CK-12 | Live, read-only (G3) | (a) a random unregistered .com → Porkbun prices equal the public `pricing/get` .com prices ±$0.01, `available`; (b) promptinjectionaudit.com → `taken`, no winner |
| CK-13 | Response hygiene | No secret, key prefix or account balance |
