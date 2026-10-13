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
