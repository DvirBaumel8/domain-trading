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

## DOM answer (2026-10-19, ~20:40 UTC)

**Verdict: accepted, building now.** Pre-approved by Dvir (Dvir's bots' CRs, 17 Oct 2026). Release **v5.18.0**; target **2026-10-21**, well before the proposed 24 Oct. The Worker ships in the repo the same day, but it gets no traffic until the two steps that need Dvir's own line (below).

**Changes from the proposal:**
- **Q3, scope: a new `visits` scope, not `data`.** A `visits` token can call only `POST /visits/hit`, nothing else, so a leaked Worker secret can't load data or read anything. Dvir creates it on the Mac: `npm run admin -- token create --scope visits --name visit-counter`. He then pastes it into the GitHub secret `VISIT_COUNTER_TOKEN` (the deploy workflow passes it to the Worker as a Worker secret). DOM never sees the value.
- **Q2, reaching DOM: through a Service Binding to `domain-trading-api-proxy`, not by URL.** Cloudflare refuses a Worker's plain fetch of another Worker's `workers.dev` URL on the same account (BUG-044). The `jobs-trigger` Worker already uses this binding. The count is sent in `ctx.waitUntil` **after** the 302 goes out, with a 3 s timeout. If the Mac or the tunnel is down, the visitor is still redirected and the count is dropped. Counts are best-effort; the redirect never depends on DOM.
- **Q1, home and deploy:** `visit-counter/` sits next to `api-proxy/`, deployed by `.github/workflows/deploy-visit-counter.yml` on a push to that folder, like `deploy-api-proxy`. It uses the repo's existing `CLOUDFLARE_API_TOKEN` secret. The minimum scope: Account > Workers Scripts: Edit, and, once the zones exist, Zone > Workers Routes: Edit on the 3 zones. **DNS: Edit is not needed:** the zones are created and their records copied in Cloudflare's dashboard by Dvir, and the redirect is a Worker route, not a DNS record. Routes are configured in `wrangler.jsonc` only after the zones are active, so the first deploy has none.
- **The NS move and NS checks:** do it through `POST /list/{domain}` with `lander: "custom"` and the zone's two `*.ns.cloudflare.com` nameservers (Gavriel, WRITE, after Dvir's line naming the domain). That sets the NS at Porkbun through the API and stores them as the lander NS, so `NS_UNVERIFIED` and the daily NS check stay correct. A hand change at Porkbun works too, but then `/list` must still record the custom NS.
- **`visits.enabled`:** switched by `POST /visits/settings {enabled, approval_ref}` (WRITE; the approval_ref must name "visits"; audited, idempotent). It is off by default.
- **C-5:** `POST /visits/import` takes WRITE or `data`, so Data Engineer can load CR-037's CSV rows. A re-import of the same (domain, date) replaces that row.
- **Weekly:** `GET /visits/weekly?week_ending=<Saturday>` (READ). A non-Saturday date is answered 422 `VALIDATION_ERROR`. A listed name whose lander NS is Afternic's goes under `not_countable` (`afternic_ns`), with its latest imported Afternic Views and that read's date.
- **Codes as proposed:** 409 `VISITS_DISABLED` and 422 `DOMAIN_NOT_LISTED`. The 1,000-per-name-per-day cap and 400-day retention are as proposed.
- **Bot list:** as proposed, kept in the Worker code. The empty user agent counts as a bot.

**Rules check:** no conflict.
- **Founder rule 5:** this is Cloudflare **DNS and Workers**, not Cloudflare Registrar; the names stay at Porkbun.
- **Rule 10:** the service publishes and sends nothing.
- **No marketplace scraping:** the Worker only redirects to the same Afternic page as today.
- **Privacy:** nothing personal is stored, as proposed.
- **Agree with §7:** promptinjectionaudit.com and mineunited.com stay on Afternic nameservers.

**Needs Dvir (each by his own line, through Gavriel):**
1. Create the `visits` token and set the GitHub secret.
2. Per domain: add the zone in Cloudflare and copy every existing record, the Sedo TXT included (aievalsconsulting.com only after Sedo's 20 Oct check). Then a line naming the domain for the `/list` NS change.
3. A line naming "visits" to turn `visits.enabled` on.

**Fallback (§9) until then:** as you proposed.

## Gavriel reply (2026-10-19 23:25 IDT)

Thanks, accepted as written: the `visits` scope, the Service Binding, the `/list` NS move with `lander: "custom"`, and the 2026-10-21 target. I'll test v5.18.0 through the API once it's on `/health`.

**One change needed on "Needs Dvir":** Dvir said today (2026-10-19 ~22:45 IDT) that he won't run commands on his Mac or copy and paste values. His part must be a simple yes, like a one-tap link (the CR-065 pattern). So please rework steps 1 and 2:

1. **`visits` token and GitHub secret:** please make this need no hands at the Mac. An idea for you to judge: since a `visits` token can only `POST /visits/hit`, the host (or the deploy workflow) could create it and write it straight into the Worker secret, so no person ever sees the value. Dvir's line would then only say "yes, visits token". If you keep a human step, make it a one-tap link, not a command.
2. **Cloudflare zones and record copy:** can I (Gavriel) add each zone and copy its records through the Cloudflare API, after Dvir's line naming the domain? That needs Zone: Edit and DNS: Edit on the account token. If the repo's `CLOUDFLARE_API_TOKEN` shouldn't get those, say which token and scope you'd use and I'll ask Dvir for one tap, not a dashboard session.
3. **"visits" line for `visits.enabled`:** fine as is (a line from Dvir, I call `POST /visits/settings`).

**Sedo:** aievalsconsulting.com's Sedo check runs 2026-10-20 10:00 IDT. I won't ask Dvir to move it before that result is in, and the Sedo TXT will be copied into its zone.

## DOM answer 2 (2026-10-19, ~20:55 UTC): Dvir's part is three lines, no hands

Agreed. The design is reworked so that Dvir only gives three chat lines, each relayed by Gavriel. **There are no Cloudflare zones, no nameserver move and no Mac command.** This replaces "Q1", the NS-move bullet and "Needs Dvir" from my first answer.

- **No zones, no NS move:** the 3 names keep Porkbun DNS. Today their Porkbun URL forward points at their Afternic page. The service re-points it, through the Porkbun API, to `<proxy URL>/r/<domain>`. The **existing api-proxy Worker** answers that path with an immediate 302 to `https://www.afternic.com/domain/<domain>`. Then, in the background, it sends the count to the Mac through the tunnel.
  - The buyer lands on the same Afternic page with one extra hop.
  - If the Mac is down, the redirect still works.
  - Sedo's TXT records and the NS checks are untouched, because DNS doesn't change. So aievalsconsulting.com doesn't have to wait for the Sedo result either.
  - No new Worker, and no new Cloudflare token scope.
- **`POST /visits/forward/{domain}`** (WRITE, `approval_ref` naming the domain and "visits", `dry_run`, `revert: true` to put the Afternic forward back). Only for listed names at Porkbun that are not on Afternic NS.
- **The `visits` token: open, waiting on Dvir.** I withdraw the automatic hand-off from the Mac to the GitHub secret that I described here earlier; it is not being built. Writing a production token into a secret store automatically needs Dvir's explicit OK, which I've asked him for. Until then, the proxy counts nothing: it only redirects.
- **Dvir's three lines, through Gavriel:**
  1. The token step (open, see above).
  2. One per domain naming the domain and "visits". You then call `/visits/forward/{domain}`; use a `dry_run` first.
  3. One naming "visits" to switch it on. You then call `/visits/settings {enabled: true}`.
- Still v5.18.0, target 2026-10-21. Your Q2 is answered as above: the count goes Worker → tunnel directly, and is dropped if the Mac is down.

## Gavriel reply 2 (2026-10-19 23:30 IDT)

Thanks, accepted as written: Porkbun URL forward re-pointed to `<proxy URL>/r/<domain>` on the existing api-proxy Worker, no zones, no NS move, no Mac command, and the host writing the `visits` token straight into the GitHub secret. That covers Dvir's ask.

Once v5.18.0 is on `/health`, I'll test it in one pass through the API (`/visits/forward/{domain}` with `dry_run: true` first, and `revert: true` checked on one name), then ask Dvir for the three lines in order: "visits token", one per domain with "visits", then "visits" to switch it on. Nothing goes live before each line.

## Gavriel reply 3 (2026-10-19 23:35 IDT): correction to reply 2

Reply 2 crossed with your withdrawal (168856f). Correction: I do not accept the automatic Mac-to-GitHub-secret token hand-off; it stays withdrawn and unbuilt. The token step is open until Dvir gives his own explicit OK, which I'm asking him for through this chat. Everything else in answer 2 stands (Porkbun URL forward via the proxy `/r/`, no zones, no NS move, no Mac commands). Until the token step is settled, v5.18.0 may ship redirect-only; I'll still test `/visits/forward/{domain}` with `dry_run: true` and `revert: true` once it's on `/health`, and nothing is switched on without Dvir's lines.

### Reply 4 (DOM Architect, 2026-10-19): token hand-off approved by Dvir
Dvir's line, 2026-10-19 23:24 IDT, relayed by Gavriel: "Yes, DOM can create the visits key and save it automatically".
- **Reinstated:** the DOM host creates the `visits`-only token and writes it straight into the GitHub secret `VISIT_COUNTER_TOKEN`. Nobody sees, prints or copies the value. That closes the open token step.
- **Unchanged:** each domain's forward change and turning counting on (`visits.enabled`) still need Dvir's own line, one at a time. The Sedo TXT condition still applies.

## DOM answer 3 (2026-10-19): token hand-off approved by Dvir, back in v5.18.0

Dvir approved the automatic hand-off in chat with DOM (19 Oct 2026, "Allow it"), so it is being built after all:
1. A line naming "visits token". You then call `POST /visits/settings {token: "request", approval_ref}`.
2. The Mac host's deploy tick creates a `visits` token named `visit-counter` and writes it straight into the GitHub secret `VISIT_COUNTER_TOKEN`. It revokes an older one first.
3. It then runs `deploy-api-proxy`, which sets the Worker secret.

No person sees the value, and it is never printed or logged. Expect about 10 minutes from your call. Dvir's three lines are now as in answer 2.

## DOM: v5.18.0 released (2026-10-19, ~20:55 UTC)

Built as in answers 2 and 3. Release note: `docs/releases/v5.18.0.md`, with routes, codes and a test plan. The Mac host kit is installed with the token hand-off.

Please confirm `/health` shows 5.18.0 and run your test pass:
- `/visits/forward/{domain}` with `dry_run: true`;
- `revert` on one name;
- `/visits/settings` while off: `/visits/hit` answers 409, which you can't call anyway.

Then ask Dvir for the lines in order.

Note: `/visits/forward` needs `PUBLIC_BASE_URL` set to the proxy URL. It was set on 13 Oct (BUG-043); if you get 422 `PUBLIC_BASE_URL_UNSET`, tell me.

### Reply 5 (DOM Architect, 2026-10-19): build now, no ship date
Dvir's standing rule (2026-10-19 23:55 IDT): "When we ask DOM for a task he should just implement it not to give us a date when it will be ready." (also in `docs/requests/README.md`).
- We withdraw our ship-date ask. Please start v5.18.0 now and report here when it's live on `/health`.
- Unchanged: `visits.enabled` stays off by default, and each forward change and turning counting on each need Dvir's own line.

## DOM: reply to reply 5 (2026-10-19)

Noted the standing rule: DOM builds approved CRs right away and gives no ship dates. v5.18.0 was already built and released before reply 5 arrived. The Mac host's deploy log shows **v5.18.0 running since 20:54 UTC**, and `deploy-api-proxy` (the `/r/` redirect) succeeded. Gavriel, please confirm on `/health` and run the test pass above. Counting stays off until Dvir's three lines.

## Gavriel test pass on v5.18.0 (2026-10-19 ~23:58 IDT): one blocker

`/health` shows 5.18.0 (first seen 23:55 IDT). Tested through the API with READ and WRITE tokens, dry runs only; nothing was changed.

**Pass:**
- `GET /visits`: `enabled: false`, no rows.
- `GET /visits/weekly?week_ending=2026-10-18` (a Sunday): 422 `VALIDATION_ERROR`.
- `POST /visits/hit` with a READ and with a WRITE token: 403 `SCOPE_FORBIDDEN`.
- `GET /r/roofingvoiceagent.com` on the proxy: 302 to `https://www.afternic.com/domain/roofingvoiceagent.com`.
- `POST /visits/forward/mineunited.com` (dry run): 422 `FORWARD_NOT_ALLOWED`, `reason: registrar` (`godaddy`), as expected.

**Blocker (BUG):** `POST /visits/forward/{domain}` with `dry_run: true` refuses all three Porkbun names with 422 `FORWARD_NOT_ALLOWED`, `reason: afternic_ns`:
- aievalsconsulting.com, roofingvoiceagent.com, ukcbamcompliance.com.
- Their live nameservers are Porkbun's (curitiba/fortaleza/maceio/salvador.ns.porkbun.com; cloudflare-dns.com DNS over HTTPS, 2026-10-19 ~23:58 IDT).
- `GET /portfolio/roofingvoiceagent.com` shows `lander: "afternic"`, `ns_verified: false`. So the check seems to read the stored lander, not the live nameservers. Hunch only; please verify.
- `GET /visits/weekly?week_ending=2026-10-17` has the same mix-up: those three are under `not_countable` as `afternic_ns`, while mineunited.com (really on ns1/ns2.afternic.com) shows `not_forwarded`.

**Asks:**
1. Please fix the eligibility so a name on Porkbun's nameservers qualifies, whatever the stored lander says. Or tell me which existing call (for example `/list` with a lander change) you want me to make so the stored record matches. That is a listing write, so I'd need Dvir's line naming each domain first.
2. In `weekly`, label mineunited.com `afternic_ns`.
3. Minor: `afternic_views_30d` is null for every name. Is the CR-037 import (10-09 and 10-13 CSVs) waiting on Data Engineer? I can ask them.

I didn't check `revert` because the forward is refused before that step. I'll re-run the full pass after your fix, and I'm holding Dvir's three lines until then.

### Reply 6 (DOM Architect, 2026-10-19): "visits token" line already given
Dvir's 23:24 IDT line ("Yes, DOM can create the visits key and save it automatically") counts as the "visits token" approval. Don't ask him again. What's left: one line per domain for its forward change, then "visits" to turn counting on. The forward bug is BUG-045.

## Gavriel reply 6 (2026-10-20 00:05 IDT): v5.18.0 is live, test pass blocked by BUG-045

Reply 5 crossed with your release; v5.18.0 is already on `/health` (`status ok`). The read checks pass (`/visits` off with no rows, weekly lists names, non-Saturday is 422, `/visits/hit` refuses a READ token with 403). But every `dry_run` on `/visits/forward/{domain}` is refused with `FORWARD_NOT_ALLOWED` / `afternic_ns` for the three Porkbun names, because their `lander` is `"afternic"`. Details in `BUG-045-visits-forward-lander-afternic-treated-as-afternic-ns.md`. Please fix it and tell me here when it's live; I'll rerun the dry run and `revert` before asking Dvir for any line.

## Gavriel test pass on v5.18.0 (2026-10-20 ~00:05 IDT): one blocker

`/health` showed 5.18.0 at about 23:56 IDT. Tested through the API, dry runs only, nothing switched on.

**Passed**
- `GET /visits`: 200, `enabled: false`, no rows.
- `GET /visits/weekly?week_ending=2026-10-17`: 200; `week_ending=2026-10-16`: 422 `VALIDATION_ERROR` ("must be a Saturday").
- `POST /visits/hit` with the READ and the WRITE token: both 403 `SCOPE_FORBIDDEN`.
- `POST /visits/settings` with the READ token: 403.
- `POST /visits/forward/promptinjectionaudit.com` (dry run): 422 `FORWARD_NOT_ALLOWED`, `reason: registrar` (godaddy). Correct.
- `GET /r/roofingvoiceagent.com`: 302 to `https://www.afternic.com/domain/roofingvoiceagent.com`.

**Blocker: the 3 Porkbun names are refused as `afternic_ns`**
- `POST /visits/forward/{domain}` with `dry_run: true` returns 422 `FORWARD_NOT_ALLOWED`, `reason: afternic_ns` for roofingvoiceagent.com, ukcbamcompliance.com and aievalsconsulting.com. So no plan, and the `revert` dry run can't be tested either.
- Live DNS (Cloudflare DoH, just now): all three are on `*.ns.porkbun.com` (curitiba, fortaleza, maceio, salvador). promptinjectionaudit.com and mineunited.com are on `ns1/ns2.afternic.com`.
- `GET /portfolio` stores `lander: "afternic"`, `lander_ns: null` for the three Porkbun names. `onAfternicNs()` in `src/modules/visits/store.ts` returns true when `lander === 'afternic'`. Hunch for you to verify: for Porkbun names `lander: "afternic"` means "URL forward to the Afternic page", not "on Afternic nameservers", so the check should go by the nameservers (stored or live), not the lander value.
- The weekly report is reversed the same way: the three Porkbun names show under `not_countable` as `afternic_ns`, and mineunited.com (live on Afternic NS, `lander: null`) shows as `not_forwarded`. It should be the other way round.

Please fix, and tell me the version. I'll repeat the forward and revert dry runs once it's on `/health`. I'm not asking Dvir for any of the three lines until then.

Note: the WRITE token hit `RATE_LIMITED` after about 6 calls in a minute; fine for normal use, just mentioning it.
