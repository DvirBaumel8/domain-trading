> Status: Approved by Dvir 2026-10-19 (proposal)

# CR-068 — $0 visitor counter for our listed names (weekly count for the Saturday sales digest)
| Field | Value |
|---|---|
| CR id | CR-068 (the repo has nothing above CR-063; CR-064, 065 and 067 are local drafts; CR-066 is reserved) |
| From | DOM Architect (Grok Bot), on behalf of Dvir |
| Date | 2026-10-19 23:25 IDT |
| Approved by Dvir | 2026-10-19 (around 23:00 IDT), via Gavriel (see Approval) |
| Priority | P2. **Ship date asked: please give a target date. We propose 2026-10-24**, so the first count is in the 2026-10-31 Saturday digest |
| Owner bot | Sales (Sochen) reads it. Data Engineer maintains the Worker config with Dvir |
| Builds on | CR-029 part B (visit store, deferred by DOM 2026-10-09) and CR-037 (Afternic views CSV in `docs/requests/visits/`) |

## 1. Goal and what exists today
Dvir wants to know whether anyone visits our 5 listed names. Afternic's dashboard shows no traffic.

**What already exists (checked 2026-10-19):**
- **CR-037:** DOM reads Afternic's 30-day Views/Leads during its Afternic runs, into `docs/requests/visits/<date>.csv`.
  - There are only 2 files: 2026-10-09 and 2026-10-13. promptinjectionaudit.com had 7 views both times; aievalsconsulting.com had 3 on 10-13; the rest had 0.
  - Afternic stats exist only for names on Afternic nameservers with Afternic's lander (CR-029 §B context).
- **CR-029 B:** a visit store, `POST /visits/import`, a privacy-light counter (R-B4) and `GET /visits` (R-B5). This was **deferred**, not built.
- **Contract:** `endpoints.md` (contract up to v5.17.0) has **no** visits, hits or redirect route. `lander` can be `afternic | sedo | custom | none`. No release note v5.10–v5.17 mentions visits.
- **Box:** no sale-page or Worker code for these names. `company/integrations-review-2026-10-16.md` item 9 lists Cloudflare D1 + Workers (free) on the existing CF account as an option. `CLOUDFLARE_API_TOKEN` is present in the box environment (checked by name only; its scope is UNKNOWN).

**Where each name points now** (public DNS over HTTPS, cloudflare-dns.com, 2026-10-19 ~23:15 IDT):

| Name | NS | A | What a visitor gets | Countable by us? |
|---|---|---|---|---|
| promptinjectionaudit.com | ns1/ns2.afternic.com | 76.223.54.146, 13.248.169.48 | Afternic/GoDaddy for-sale lander | **No** (Afternic Views only) |
| mineunited.com | ns1/ns2.afternic.com | 76.223.54.146, 13.248.169.48 | Afternic/GoDaddy for-sale lander | **No** (Afternic Views only) |
| aievalsconsulting.com | Porkbun (curitiba/fortaleza/maceio/salvador.ns.porkbun.com) | 207.207.210.23/.36/.50 | Porkbun URL forward: `https://` → 302 to `https://www.afternic.com/domain/aievalsconsulting.com` (checked) | Yes, after the change below |
| ukcbamcompliance.com | Porkbun | same 207.207.210.x | same pattern (HTTP from the box timed out; probably the same forward, UNKNOWN) | Yes, after the change |
| roofingvoiceagent.com | Porkbun | same 207.207.210.x | same pattern (UNKNOWN, as above) | Yes, after the change |

## 2. Options compared
- **(a) Count each hit at a redirect we control, store only daily counts in DOM. ← PRIMARY**
  - The 3 Porkbun-NS names already redirect to their Afternic page. Our redirect does the same, adding one count.
  - It keeps the same buyer path and costs $0: Cloudflare Workers free tier, and the existing CF account.
  - We control exactly what is kept (R-3).
- **(b) Cloudflare Web Analytics:** rejected as primary.
  - It counts with a JavaScript beacon on an HTML page. A 302 redirect serves no page, so it would count 0.
  - We'd have to host a page instead of the Afternic redirect, which adds a click for the buyer.
  - Zone request analytics (no beacon) could give counts per host, but free-plan bot filtering and API access are UNKNOWN.
- **The 2 names on Afternic nameservers** can't be counted by either option, because Afternic serves their page, not us. They stay on CR-037's Afternic Views read.

## 3. Contract change
- **C-1 (edge, $0):** move the 3 Porkbun-NS names' nameservers to the existing Cloudflare account (free zones). A Worker on those hostnames answers every request with **302 to `https://www.afternic.com/domain/<name>`**, the same target as today.
  - After answering, it sends one small event to DOM: `{domain, ua_class}`.
  - The Worker holds the DOM token as a Worker secret.
  - DOM holds the Worker code in its repo, and DOM deploys it the same way as the existing `api-proxy` Worker.
- **C-2 (DOM route):** `POST /visits/hit` takes the CR-061 `data` scope (a non-money token) or a new `visits` scope.
  - Body (strict) `{domain, ua_class: "human"|"bot", referrer_host?: string|null}`.
  - DOM sets the UTC date itself.
  - Only names that are `listed` in DOM are accepted. Others → 422 `DOMAIN_NOT_LISTED` (code name proposed).
  - Rate limit: the existing per-token limit, plus at most 1,000 hits per name per day (more are dropped and counted as `capped`).
- **C-3 (table):** `visit_daily {domain, date_utc, source: "dom_redirect"|"afternic", human_hits, bot_hits, capped, referrer_hosts: jsonb {host: n} (top 10, the rest as "other")}`.
  - It is one row per domain, day and source, upserted by incrementing the counts.
  - It reuses CR-029 R-B1's shape, cut down.
- **C-4 (read):** `GET /visits?from=&to=` with READ scope returns daily rows. `GET /visits/weekly?week_ending=YYYY-MM-DD` (READ) returns `{week_ending, rows: [{domain, source, human_hits, bot_hits, top_referrers}], not_countable: [{domain, reason: "afternic_ns"}]}`, with the week running Sunday–Saturday in UTC.
- **C-5 (Afternic numbers in the same view):** CR-029 R-B2's import gets a minimal form: `POST /visits/import {domain, date, views_30d, leads_30d}` (WRITE or data). Gavriel or DOM loads CR-037's CSV rows, so the weekly view shows Afternic Views for the 2 Afternic-NS names as `source: "afternic"`.
- **C-6 (the Saturday digest):** Sales reads `GET /visits/weekly` with its own READ token every Saturday morning. It copies the per-domain lines into the digest, with the "not countable" names labelled "Afternic Views only (last read <date>)".

## 4. Privacy
- **Stored:** daily aggregates only: counts per domain, day and source, and referrer **host** counts.
  - **No raw hit rows** are kept. The Worker sends an event, and DOM only increments the counters. There is no request log table, and no raw rows even for 7 days.
- **Never stored or sent:**
  - IPs, raw or hashed (unlike CR-029's daily-salted IP hash, which this drops);
  - cookies (the Worker sets none);
  - full URLs, paths or query strings;
  - the full user-agent string.
- **Bot filter:** the Worker sets `ua_class: "bot"` for user agents that match a fixed list (`bot|crawl|spider|slurp|preview|monitor|curl|wget|python|http-client|headless`, plus an empty UA). Cloudflare's `cf.botManagement` isn't on the free plan (UNKNOWN), so it isn't used. Bot hits are counted apart, never mixed with humans.
- **Retention:** daily rows are kept 400 days, then deleted by the existing retention job. Referrer hosts are capped at the top 10 per day.
- **Legal:** this is not personal data. Mishpatan to confirm that no cookie banner is needed (no cookies, no IP).

## 5. Settings and activation
- No setting is activated without Dvir's line. The new `visits.enabled` flag defaults to **false**.
- Moving the 3 names' nameservers is a DNS change at Porkbun. **Dvir does it** or approves it, because it changes where buyers land.
- Deploying the Worker needs the Cloudflare token. Its scope is UNKNOWN; DOM states the minimum scope needed (Workers Scripts:Edit, Zone:DNS:Edit on the 3 zones).

## 6. DOM-enforced or not (per step)
| Step | DOM-enforced? |
|---|---|
| The redirect target equals the name's Afternic page | Not by DOM (Worker config); acceptance test AT-2 checks it |
| Only listed names counted | **DOM-enforced** (`DOMAIN_NOT_LISTED`) |
| No IP, cookie or URL stored | **DOM-enforced** by the strict body (only 3 fields); the Worker side is checked by AT-6 |
| Bot split | Worker-side (not DOM); DOM stores the two counts apart |
| Per-day cap | **DOM-enforced** |
| Retention 400 days | **DOM-enforced** (retention job) |
| `visits.enabled` off until Dvir's line | **DOM-enforced** (setting) |
| NS change at Porkbun | Not DOM (Dvir, by hand) |

## 7. Trade-off: moving the 2 Afternic-NS names off Afternic
- **Commission:** Afternic charges **15% only when the name uses Afternic nameservers at the time of sale, 25% otherwise** (`archive/system/system/selling-playbook.md` §4.3 [V]). On a $3,488 mineunited.com sale, that is about $349 more. The 3 Porkbun-NS names already pay this.
- **Trust:** we'd lose Afternic's own lander, with its GoDaddy trust and "Fast Transfer" badges (§4.3).
- **Fast Transfer:** whether it needs Afternic NS is **UNKNOWN** from our docs.
  - D-003's file says it needs a Porkbun setting ("Afternic – Allow Fast Transfer Opt-Ins") plus opt-in at buy + 60 days, which is registrar-based.
  - D-005's file says "once listed with Afternic NS".
  - Gavriel to check with Afternic help before any move.
- **Recommendation:** don't move them for a counter. Keep promptinjectionaudit.com and mineunited.com on Afternic NS, and count them with Afternic Views (CR-037).

## 8. Acceptance tests
- **AT-1:** with `visits.enabled` false → `POST /visits/hit` is 409 `VISITS_DISABLED` (code proposed) and nothing is stored.
- **AT-2:** `curl -I https://aievalsconsulting.com/` → 302 to `https://www.afternic.com/domain/aievalsconsulting.com`. The same for the other 2 names, on both http and https.
- **AT-3:** 3 human hits and 2 bot hits (UA `Googlebot`) on ukcbamcompliance.com → `GET /visits` shows human_hits 3 and bot_hits 2 for that UTC day.
- **AT-4:** a hit for `promptinjectionaudit.com` (not on our edge) or a name not listed → 422 `DOMAIN_NOT_LISTED`. A body with an extra key `ip` → 422 `VALIDATION_ERROR`.
- **AT-5:** a referrer of `https://x.com/abc?utm=1` is stored as `x.com` only. No path or query appears in any table.
- **AT-6:** after AT-3..5, a search of every DB table, the `/audit` rows and the job logs for the test IPs, the full UA string and the paths finds nothing. The Worker's response has no `Set-Cookie`.
- **AT-7:** `GET /visits/weekly?week_ending=<Sat>` lists the 3 counted names, plus promptinjectionaudit.com and mineunited.com under `not_countable` (`afternic_ns`), with their latest Afternic Views if imported.
- **AT-8:** the 1,001st hit on one name in one day → `capped` +1, and the human/bot counts don't change.
- **AT-9:** the data token cannot `GET /visits` (403, `data` scope rule). A READ token can't `POST /visits/hit` (403).

## 9. Box-only fallback if this isn't shipped by the Saturday digest
Sales quotes the latest CR-037 Afternic Views CSV, and labels the 3 Porkbun-forwarded names "not counted yet".

## 10. Open questions for DOM
- Q1: should the Worker live in the repo next to `api-proxy`, with DOM deploying it? What Cloudflare token scope is the minimum?
- Q2: is the Mac host reachable from the Worker through the existing tunnel and proxy? If DOM is down, the Worker must still redirect and simply drop the count.
- Q3: is the `data` scope or a new `visits` scope better for the Worker token?
- **Ship date:** please give a target date (we propose 2026-10-24).

## Approval
Dvir, 2026-10-19 (around 23:00 IDT), relayed by Gavriel: "I also want a visitor count check and if there was an offer for our listed domains", then, after Gavriel described the counter, "Yes want that".
- **Covered by this approval:** building the counter.
- **Not covered:** turning on `visits.enabled` and moving the 3 names' nameservers to Cloudflare each still need Dvir's own line.
- **Sedo condition:** do not move any name's nameservers while its Sedo ownership check (a DNS TXT record) is still pending. aievalsconsulting.com is mid-check, and the check runs 2026-10-20 10:00 IDT. Copy every Sedo TXT record into the new Cloudflare zone before the move.
- promptinjectionaudit.com and mineunited.com stay on Afternic nameservers.

<!-- DOM writes below this line -->
