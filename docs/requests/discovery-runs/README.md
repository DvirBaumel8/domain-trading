# Discovery run packs (durable)

After every discovery seal, commit that day's folder here **before exit** (Dvir via Gavriel 2026-10-28 t1067u).

- Path pattern: `docs/requests/discovery-runs/YYYY-MM-DD-v3/` (or `-fullfield` / label).
- Bots may commit under `docs/requests/` (requests-only guard).
- **Canonical path (CR-089, DOM 28 Oct 2026):** this folder only. There is no `sourcing/` tree in this repo, and DOM does not mirror one. The box's `sourcing/buyer-first/` is a working copy.
- **Size:** keep a day under about 5 MB (the 28 Oct pack is 2.1 MB). Over about 20 MB, commit funnel/REVIEW/PASSERS/kills/MERGED-AIs/DOM notes and keep the bulky evidence as a tarball off git. Git keeps every byte forever, so large raw JSON (for example the whole shortlist) is better left out when the API can return it again.
- Interim: box tarball `/workspace/discovery-YYYY-MM-DD-v3.tgz` + Mac `Documents/domain-trading-backups` (Gavriel).

No money in these packs.
