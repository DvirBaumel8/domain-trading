# On-Apify verification (25 Nov 2026, unpublished)

Account: looped_kite (Free plan). All 3 Actors remain **private** (`isPublic: false`). Token was never printed.
Builds: all SUCCEEDED (version 0.1.1). Runs used 256 MB memory.
Total platform usage for 10 verification runs: **$0.0070** (Free credit).

## Actors
| Actor | ID | Console | Build |
|---|---|---|---|
| bulk-domain-availability-checker | mKqSGmlx8krmtqgpU | https://console.apify.com/actors/mKqSGmlx8krmtqgpU | 0.1.1 SUCCEEDED |
| sitemap-url-extractor | HcsxPAYrb95rOsOrQ | https://console.apify.com/actors/HcsxPAYrb95rOsOrQ | 0.1.1 SUCCEEDED |
| bulk-dns-email-auth-checker | VnrYq91nbRYrRMmS1 | https://console.apify.com/actors/VnrYq91nbRYrRMmS1 | 0.1.1 SUCCEEDED |

## Pass/fail table

| Actor | Case | Expected | Result | Time | Cost | Verdict |
|---|---|---|---|---:|---:|---|
| domain | known-answers+invalid | google.com/example.org/rentguitar.com registered; two gibberish .com available; invalid lines skipped | SUCCEEDED, 5 rows: google.com registered (MarkMonitor, 1997-09-15); example.org registered (ICANN); rentguitar.com registered, Afternic for-sale, GoDaddy 2009-09-25; quietbluefalcon8812.com and zzqqxx…com available via RDAP; 0 unknown | 4.1s | $0.00005 | PASS |
| domain | empty-input | fail with a clear message, 0 rows | FAILED exit 1, "No valid domains or keywords in input.", 0 rows | 2.5s | $0.00009 | PASS |
| domain | invalid-only | same as empty (invalid not charged) | FAILED exit 1, same message, 0 rows | 2.8s | $0.00009 | PASS |
| domain | batch-200 | 200 unique names, no crash, all classified | SUCCEEDED, 200/200 unique, all available via RDAP, 0 unknown | 79.4s | $0.00138 | PASS |
| sitemap | two-sites-incl-index | 2+ real sites, walk a sitemap index, cap 200/site | SUCCEEDED, 600 URLs: apify.com 200, wordpress.org/news 200 from 3 sitemap files (index), docs.apify.com/sitemap.xml 200 (followed to sitemap_base.xml) | 5.0s | $0.00313 | PASS |
| sitemap | empty-input | fail with a clear message | FAILED exit 1, "Add at least one website or sitemap URL.", 0 rows | 2.8s | $0.00009 | PASS |
| sitemap | no-sitemap | no crash, 0 URLs | SUCCEEDED, 0 rows, "Done: 0 URLs from 1 site(s)." | 43.1s | $0.00066 | PASS |
| dns | known-answers | stripe/gmail work; example.com no-MX; gibberish NXDOMAIN | SUCCEEDED, 7 rows: stripe.com Google Workspace, DMARC reject, score 80; gmail.com Google Workspace MX; example.com null MX; zzqqxx… NXDOMAIN; microsoft.com Microsoft 365, score 93; invalid skipped | 3.4s | $0.00016 | PASS |
| dns | empty-input | fail with a clear message | FAILED exit 1, "No valid domains in input.", 0 rows | 2.4s | $0.00009 | PASS |
| dns | batch-200 | 200 domains, no crash | SUCCEEDED, 200 rows, 0 errors, all NXDOMAIN as expected for made-up names | 5.5s | $0.00122 | PASS |

**Overall: 10/10 PASS. Combined cost $0.0070.**

## Notes (not failures)
- gmail.com SPF is `v=spf1 redirect=_spf.google.com`. The Actor records the redirect but does not follow it, so `spfAll` is blank. This is a limitation, not a crash.
- google.com / gmail.com have no DKIM on the default selector list (their custom selectors). The README already explains this.
- The no-sitemap case spent 43s retrying robots.txt and common paths on a non-existent host. Slow but correct.

## Metadata / pricing via API
- Set without publishing: title, description, seoTitle, seoDescription, categories, default memory 256 MB, LIMITED_PERMISSIONS.
- Pricing/monetization **blocked**: `cannot-monetize-without-payout-billing-info`. Needs payout billing in Console first. Not forced.
- Logos generated locally as 512×512 PNG in each Actor folder. No working upload endpoint found; upload in Console.
- Publishing Terms were **not** accepted. Actors were **not** made public.
