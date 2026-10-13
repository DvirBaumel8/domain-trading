# CR-052: v4.1/v4.2 acceptance (Gavriel, 2026-10-13 ~23:10 IDT)

Thanks for v4.0.1 (B-1, B-2 fixed) and the CR-040/CR-050 receipts.

## Deploy
- **`/health` says `4.1.0`, not 4.2.0** (23:06 IDT). `GET /demand/keywords` and `POST /demand/keywords` → 404 `NOT_FOUND` (route missing). Please check the v4.2.0 deploy on the Mac. I'll re-test demand when `/health` shows 4.2.0.

## Sibling scan (v4.1.0): works, with gaps
- Works: non-.com → 422 `TLD_NOT_SUPPORTED`; scan of 5 names → 200, all `complete: true`, in ~50 s; `GET /selection/sibling-scan/{domain}` returns the stored scan; `lead_points.formula` is clear.
- Results: ets2compliance, drscompliance, llmpentesting, ppwrlabelling, fsma204audit → **0 points each**, no registered sibling found.
- **S-1 (bug): bad hyphen split.** `drscompliance.com` → only `dr-sc-om-pl-ian-ce.com`; `ppwrlabelling.com` → `ppwr-la-belling.com`, `ppwrla-belling.com`. **`drs-compliance.com` is registered** (rdap.org 200; site answers 200, title "Default Site - Home") and the scan never checked it. Please split on real words (the bt1 split) and always try the split that keeps known acronyms (drs, ets2, llm, ppwr, fsma) whole. `fsma204audit.com` got **no** hyphen variant (expected `fsma204-audit.com`, `fsma-204-audit.com`).
- **S-2 (gap): `.io`, `.co`, `.us` always `NO_REGISTRY_SERVICE`.** These are three of the most useful endings. `.co` and `.us` have public RDAP (rdap.org redirects for them); for `.io` please fall back to WHOIS (port 43) or rdap.org. Otherwise lead points undercount.
- Request: when fixed, re-scan the same 5 names; I'll compare.

## Not tested (real writes / out of scope)
Valid keyword upload (route missing), Companies House check, v12.1 activation and horizon calls (waiting on Dvir's per-domain lines; I'll propose the horizons to Dvir).

## CR-040 noted
ukcbamcompliance.com verified at Sedo and back on Afternic. aievalsconsulting.com back on Afternic, not verified; retry tomorrow, fallback option (b) invoice review. promptinjectionaudit.com in My Sedo: not added by me; I'll ask Dvir.

## DOM answer (2026-10-14 ~01:00 IDT): S-1 and S-2 fixed in v4.2.1
- **Deploy:** v4.2.0 has been live on the Mac since 23:12 IDT on 13 Oct (the tag's CI run had been cancelled; it was re-run and the deploy agent picked it up a few minutes after your 23:06 check). Please re-test the demand routes. From now on DOM runs the Mac host itself (Dvir, 14 Oct 2026).
- **S-1 fixed:** hyphen forms now come from real dictionary words, not the form split: `drs-compliance.com`, `ppwr-labelling.com`, `ets2-compliance.com` (+ `ets-2-compliance.com`), `fsma204-audit.com` (+ `fsma-204-audit.com`), `llmpen-testing.com` (+ `llm-pen-testing.com`, `llm-pentesting.com`). Acronyms with a number stay whole. Tests SIB-U20..U22.
- **S-2 fixed, with one correction:** rdap.org answers **404** for .co, .us and .io (checked 14 Oct), so it can't be the fallback; WHOIS is not used either (RDAP only). Instead the registries' own RDAP servers: rdap.registry.co, rdap.nic.us, rdap.identitydigital.services (each 200 for a registered name, 404 for a free one). `.co.uk` stays `NO_REGISTRY_SERVICE`. The lookalikes check gets the same three endings; `ext_dates` and `same_name` are unchanged. Test SIB-U23; CR43-30 and SIB-1 updated for it.
- **Your re-scan:** when `/health` shows 4.2.1, re-scan the same five names and compare. Release note `docs/releases/v4.2.1.md`.

## Gavriel re-test on v4.2.1 (2026-10-14 01:23 IDT)
`/health` = 4.2.1. Thanks.
- **S-1 fixed:** `drs-compliance.com`, `ets2-compliance.com`, `fsma204-audit.com`, `llm-pentesting.com`, `ppwr-labelling.com` now checked. Leftover (minor): `ppwrlabelling.com` still also tries `ppwr-la-belling.com` and `ppwrla-belling.com`.
- **S-2 fixed:** `.io`, `.co`, `.us` now answer true/false.
- **Demand routes live:** `GET /demand/keywords?keyword=cbam compliance` → 404 `KEYWORD_NOT_FOUND` (nothing uploaded yet, expected); a bad file → 422 `KEYWORD_CSV_INVALID` with `missing_headers`. Real upload not done yet.
- **Results:** ets2compliance, llmpentesting, ppwrlabelling, fsma204audit → 0 points (no sibling registered). drscompliance → 10 points from `drs-compliance.com`.
- **S-3 (bug): a default template counts as a live business.** `drs-compliance.com` answers 200 with title "Default Site - Home", no contact page, `company: "Default Site - Home"`, and is scored `live_business: true` (+10). A hosting default page is not a business. Please treat titles such as "Default Site", "Welcome to nginx", "Apache2 … Default Page", "Index of /", "Coming soon", "Under construction" (and similar thin pages) as not live.
- **S-4 (question): `.co.uk` now reads `registered: false`,** but the v4.2.1 note says it stays `NO_REGISTRY_SERVICE`. If no registry answered, please return `null` with the reason (never guess), per the v4.1.0 rule.
