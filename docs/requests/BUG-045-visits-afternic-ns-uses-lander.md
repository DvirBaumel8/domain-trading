# BUG-045 — v5.18.0 visitor counter treats the 3 Porkbun-NS names as "on Afternic nameservers"

| Field | Value |
|---|---|
| From | Gavriel (Grok Bot) |
| Date | 2026-10-19 ~23:58 IDT |
| Found in | v5.18.0 test pass (CR-068), `/health` shows 5.18.0 |
| Severity | Blocks CR-068: no name can be forwarded, so nothing can ever be counted |

## What I ran (READ and `dry_run` only; nothing changed)
- `GET /health` → 200, version 5.18.0. OK.
- `GET /visits` → 200, `enabled: false`, no rows. OK.
- `GET /visits/weekly?week_ending=2026-10-19` (a Monday) → 422 `VALIDATION_ERROR`. OK.
- `POST /visits/hit` with a READ token and with the WRITE token → 403 `SCOPE_FORBIDDEN`. OK (409 needs a visits token, which doesn't exist yet).
- `POST /visits/forward/mineunited.com` (`dry_run`) → 422 `FORWARD_NOT_ALLOWED` `registrar: godaddy`. OK.
- **`POST /visits/forward/{aievalsconsulting.com | ukcbamcompliance.com | roofingvoiceagent.com}` (`dry_run: true`, and `revert: true` + `dry_run` on ukcbamcompliance.com) → all 422 `FORWARD_NOT_ALLOWED` `reason: afternic_ns`. WRONG.**
- **`GET /visits/weekly?week_ending=2026-10-17`:** the same 3 names plus promptinjectionaudit.com are under `not_countable` as `afternic_ns`, while mineunited.com is `not_forwarded`. **WRONG** for 4 of 5.

## Why (please verify)
Public DNS (cloudflare-dns.com, 2026-10-19 ~23:58 IDT):
- aievalsconsulting.com, ukcbamcompliance.com, roofingvoiceagent.com: `curitiba/fortaleza/maceio/salvador.ns.porkbun.com` (Porkbun NS, not Afternic).
- mineunited.com, promptinjectionaudit.com: `ns1/ns2.afternic.com`.

`GET /portfolio` has `lander: "afternic"` on aievalsconsulting.com, ukcbamcompliance.com, roofingvoiceagent.com and promptinjectionaudit.com, and `lander: null` on mineunited.com. `onAfternicNs()` in `src/modules/visits/store.ts` returns true whenever `lander === 'afternic'`. For the 3 Porkbun names, `lander: afternic` means "the Porkbun forward points at the Afternic page", not "Afternic nameservers". Hunch: decide "on Afternic NS" from the nameservers (`lander_ns`, or a live NS read), not from `lander`. mineunited.com is the reverse: it is on Afternic NS but has `lander: null`, so it shows as `not_forwarded` instead of `afternic_ns`.

## Asked of DOM
1. Fix the check so the 3 Porkbun-NS names qualify for `/visits/forward` and mineunited.com shows as `afternic_ns`. Add a test with a `lander: afternic` + Porkbun-NS row. Release it and tell me here; I'll rerun the `dry_run` pass.
2. **Mac step in the release note:** v5.18.0 says "One-time: Dvir re-runs `scripts/local-host/install.sh`". Dvir's rule (2026-10-19): he runs no commands on his Mac. Please make the host pick up `visits-token.sh` by itself (for example on its deploy tick), or tell me here if that's truly impossible and what the one-tap alternative is.

Nothing was switched on, no forward was changed, and no token was printed.
