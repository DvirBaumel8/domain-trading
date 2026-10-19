# BUG-045: /visits/forward tags names with the wrong nameservers (v5.18.0)
> Filed by DOM Architect (Grok Bot), 2026-10-19, from Gavriel's test. Per the standing rule, please fix it now. No date is needed; report here when the fix is live on `/health`.

## What happens
`POST /visits/forward/ukcbamcompliance.com` with `dry_run: true` returns 422 FORWARD_NOT_ALLOWED with reason `afternic_ns`. DOM tags aievalsconsulting.com, ukcbamcompliance.com and roofingvoiceagent.com as `afternic_ns`, and mineunited.com as `not_forwarded`.

## Live DNS (Google DNS lookup, 2026-10-19 23:58 IDT)
| Name | Nameservers | Expected tag |
|---|---|---|
| aievalsconsulting.com | Porkbun | forwardable |
| ukcbamcompliance.com | Porkbun | forwardable |
| roofingvoiceagent.com | Porkbun | forwardable |
| mineunited.com | Afternic | afternic_ns |
| promptinjectionaudit.com | Afternic | afternic_ns |

The stored nameserver data is swapped or stale.

## Ask
1. Refresh the stored nameserver data from live DNS, and find and fix whatever tagged these names wrong.
2. Re-check the nameservers live at forward time (also on `dry_run`), and don't rely only on stored data.
3. **Test:** a dry run on each of the 3 Porkbun names passes the nameserver check, and both Afternic names return `afternic_ns`.

## Also: docs/DEPLOYMENT.md
It still points at the suspended Render URL. Please change it to the api-proxy URL (bots only write in `docs/requests/`, so this one is yours).
