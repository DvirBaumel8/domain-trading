> Status: Fixed in v5.19.1

# BUG-046 — `/r/<domain>` redirects fine but no hit is ever stored, even after the `VISITS_TOKEN` Worker secret was set
| Field | Value |
|---|---|
| BUG id | BUG-046 |
| From | Gavriel |
| Date | 2026-10-20 00:52 IDT |
| Contract version | v5.19.0 (live on `/health` at 00:35 IDT) |
| Severity | wrong data (the counter shows zero for every name) |

## What I did (v5.19.0 "Impact on Gavriel")
- `GET /health` = 5.19.0, status ok, jobs ok. `GET /visits` = `enabled: true`.
- `POST /visits/forward/{domain}` `{dry_run: true}`: 200 for ukcbamcompliance.com, aievalsconsulting.com, roofingvoiceagent.com (before = Afternic page, after = `/r/{domain}`). promptinjectionaudit.com and mineunited.com: 422 `FORWARD_NOT_ALLOWED` with `reason: "registrar"` (godaddy), not `afternic_ns` as the release note's test step says. Fine by me, just noting the release note is off.
- READ token on `/visits/forward`: 403 as expected.
- Real forwards (body `{}`, Idempotency-Key `v519-real-<domain>`), 200 each: ukcbamcompliance `aud_93a93d652c3320f0538c851ddf10bd04`, aievalsconsulting `aud_3ea4675f8dfa856a7a2e90e8a8302ed8`, roofingvoiceagent `aud_11864471b073688e35664a62a08c4bae`.
- End to end: `https://<name>/` -> 302 `/r/<name>` -> 302 Afternic page, 200, for all three. (Plain `http://` can't be tested from our box, it blocks port 80.)
- `GET /visits/weekly?week_ending=2026-10-24`: the three names in `rows` with zeros; mineunited and promptinjectionaudit under `not_countable` `afternic_ns`. Good.

## Expected
`docs/internal/visits.md` rule 1 and `api-proxy/src/index.ts` `countingRedirect`: once the Worker has `VISITS_TOKEN`, each `/r/<domain>` GET posts one hit, so `GET /visits` shows a `dom_redirect` row (bot UAs count as `bot_hits`).

## Got
- `VISIT_COUNTER_TOKEN` repo secret set 21:45:37Z; `deploy-api-proxy` run at 21:45:38Z succeeded and its log shows "Success! Uploaded secret VISITS_TOKEN" at 21:46:07Z (00:46 IDT).
- I hit `/r/ukcbamcompliance.com`, `/r/aievalsconsulting.com` and the roofingvoiceagent.com forward about 8 times between 00:47 and 00:50 IDT (curl UA = bot, and a Safari UA = human).
- `GET /visits?from=2026-10-19&to=2026-10-20` at 00:50:21 IDT: `{"enabled":true,"rows":[]}`. Nothing stored.

## Hunches (please verify, I can't see the hit responses)
1. The Worker's `sendHit` has a 3 s timeout and swallows errors. Calls through the quick tunnel to the Mac host often take 1-6 s from here (the real forwards took about 6 s each), so the hit may simply time out.
2. Or `POST /visits/hit` is refused (401/403/422) for the new `visit-counter` token or for these names. A log line on the Mac host per refused hit (status code only, no request data) would show which.
Nothing was reverted. The forwards stay on, since visitors still land on the Afternic page either way.

<!-- DOM writes below this line -->

## DOM response (2026-10-20): fixed in v5.19.1

Your second hunch was right. The Mac host log shows every `/visits/hit` from the Worker arriving, in 0.5–1.2 s (no timeout), and answered **422**. Cause: the hit path still used the stored `lander_ns`, which says Afternic for the three Porkbun names. The BUG-045 fix had moved only `/visits/forward` and `/visits/weekly` to live DNS.

Fix: a hit counts for a `listed` name with an **active forward**; your three forwards qualify. A refused hit now logs one host line with the code and domain (your suggestion). Nothing to redo on your side. After the deploy, open `/r/<name>` a few times and check `GET /visits`. You were also right about the `registrar` reason for the two GoDaddy names; the release note says so.
