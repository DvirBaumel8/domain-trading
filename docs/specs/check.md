# GET /check?domain=<name>  (READ)

**Goal:** check whether a domain is available, and get **live** prices from every enabled registrar, compared on **first year + exactly one renewal** (Dvir's max-one-renewal rule).

## Behaviour
1. **Normalise the input:** lowercase it, then validate it as an FQDN. In v1 it must end in `.com`; anything else gets **422** `TLD_NOT_SUPPORTED`.
2. **Check RDAP:** `https://rdap.verisign.com/com/v1/domain/<d>`.
   - 404 = not registered. 200 = registered. Anything else = `rdap_unknown`.
3. **Ask each enabled adapter for a quote** (`adapter.quote`), in parallel.
   - Timeout: 8 s per adapter.
   - An adapter error excludes that registrar only, with the reason recorded.
4. **Work out the cost per registrar:**
   `two_year_cents = first_year_cents + renewal_cents + 2 × privacy_cents_per_year`.
   Privacy counts only if it is paid. **Never more than one renewal.**
   - For GoDaddy (if enabled), the renewal is the **standard** manual-renewal rate, because the service keeps auto-renew off.
5. **Mark each registrar eligible or not** (`docs/research/registrars.md`). A registrar is excluded if any of these holds:
   - no API or no adapter;
   - no custom nameservers (so Cloudflare is always excluded): `NO_CUSTOM_NAMESERVERS`;
   - the adapter is management-only (`can_quote`/`can_register` false, e.g. GoDaddy for an account with <50 domains): `NO_AVAILABILITY_ACCESS`;
   - the registrar isn't in `settings.allowed_registrars`: `REGISTRAR_NOT_ALLOWED`;
   - the adapter errored: `ADAPTER_ERROR` (the quote carries `error_code`);
   - not available: `NOT_AVAILABLE`;
   - premium: `PREMIUM`;
   - not USD: `NOT_USD`;
   - the registry's minimum term is not 1 year: `MULTI_YEAR_MINIMUM` (founder rule 3);
   - the first-year price is missing: `NO_FIRST_YEAR_PRICE`;
   - the renewal price is missing: `NO_RENEWAL_PRICE`.
   - The first three are known before quoting, so those adapters are **not called** (Dvir, 5 Oct 2026).
6. **Pick the winner:** the lowest `two_year_cents` among eligible registrars. Tie-break, in order:
   1. prepaid payment model;
   2. Afternic Fast Transfer verified;
   3. adapter order `porkbun > dynadot > namecom > others`.
7. **Overall availability:**
   - **Any disagreement means `unknown`, and the response shows no winner.** Disagreement = adapters disagree among themselves, or RDAP says 200 while an adapter says available, or RDAP says 404 while an adapter says not available (Dvir, 5 Oct 2026).
   - Otherwise `taken` if RDAP says 200 **or** any adapter says not available.
   - Otherwise `available` if RDAP says 404 and ≥1 adapter says available.
   - Otherwise `unknown`. Only `available` shows a winner.
8. **Store** every quote (`quotes`) under a new `check_id`.
9. **Cache:** 60 s per domain, to respect Porkbun's 10 checks per 10 s. A cached answer is replayed whole (same `check_id`). `/buy`'s live re-check bypasses the cache and does not write to it.

## Response (200)
Example from before D-001 was bought (it is now registered, so a live check returns `taken`).
```json
{ "domain":"promptinjectionaudit.com", "check_id":"chk_…", "checked_at":"2026-10-04T09:12:03+03:00",
  "availability":"available", "rdap":"not_registered",
  "winner":{"registrar":"porkbun","first_year":"$11.08","renewal":"$11.08","two_year":"$22.16"},
  "quotes":[{"registrar":"porkbun","eligible":true,"available":true,"premium":false,
             "first_year_cents":1108,"renewal_cents":1108,"privacy_cents_per_year":0,"two_year_cents":2216},
            {"registrar":"namecom","eligible":true,"first_year_cents":1299,"renewal_cents":1799,"two_year_cents":3098},
            {"registrar":"cloudflare","eligible":false,"exclusion_reason":"NO_CUSTOM_NAMESERVERS"}],
  "warnings":["Cheapest first year (namecom $12.99) is not cheapest over 2 years"] }
```
The numbers above are an example; in practice Name.com isn't enabled until its adapter exists.

## Phase-later (docs only; not built until Dvir says so): `GET /check/batch` (READ)
- **What:** scouts run this **first**, on a list of candidate names (≤50 per call), before any card is written. No pricing, no registrar quote.
- **Per name, three checks:** (1) **RDAP availability** (Verisign RDAP; 404 = available); (2) **Wayback history**: CDX query for `http://<name>` first, then `https://` (old sites were mostly http), returning the first/last capture years and capture count; (3) **SURBL** listing (DNS lookup `<name>.multi.surbl.org`).
- **Response:** `[{"domain","available","rdap_status","wayback":{"first","last","captures"},"surbl_listed","checked_at"}]`, plus per-check errors (one failed check doesn't fail the name). Rate-limited like other GETs; results cached 24 h.
- **Then** the full `GET /check` (quotes) runs only on names that are available, have no bad history and aren't listed.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| CK-1 | Mocked: A is $5.00 first year + $25.00 renewal; B is $11.08 + $11.08 | Winner B ($22.16); the warning mentions A | A wins |
| CK-2 | Cloudflare-type adapter is the cheapest | Excluded with `NO_CUSTOM_NAMESERVERS`; the next one wins | Cloudflare wins |
| CK-3 | Paid privacy of $3/yr | Adds $6 to `two_year` | Added once or not at all |
| CK-4 | Premium quote | Excluded `PREMIUM` | Eligible |
| CK-5 | One adapter times out | It is excluded with `ADAPTER_ERROR`; the others are still compared; 200 | 500 for the whole call |
| CK-6 | RDAP 200, adapter says available | `availability: unknown`, no winner | A winner is shown |
| CK-7 | Missing renewal price | Excluded `NO_RENEWAL_PRICE` | Eligible with renewal = 0 |
| CK-8 | Exact tie | Tie-break order applied deterministically | Random or unstable |
| CK-9 | Two-year rule | `two_year` = first year + **1** renewal (never 2), checked on 20 random fixtures | Any mismatch |
| CK-10 | `.net` input | 422 `TLD_NOT_SUPPORTED` | Accepted |
| CK-11 | READ token / no token | 200 / 401 | Other |
| CK-12 | Live, read-only (gate G3) | `GET /check` on (a) a random unregistered .com → Porkbun first year and renewal equal the public `pricing/get` .com prices within $0.01, `availability: available`; (b) promptinjectionaudit.com (bought by hand at GoDaddy, registered 4 Oct) → `availability: taken`, no winner | Mismatch, or a live call errors |
| CK-13 | Response hygiene | No secret, key prefix or account balance in the body | Any leak |
