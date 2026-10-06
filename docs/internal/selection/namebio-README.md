> Repo copy (6 Oct 2026) of `system/data/namebio/README.md` on Gavriel's box. Spec: `../selection.md` (DEMAND-1, C7/C20, `/comps/keyword`, SEL9-4/13). Where the cache lives in production is an open build decision (the Render free disk is ephemeral; see the note at the top of `../selection.md`).

# NameBio free CSV cache

Nightly backend job (selection v9.1 C20; DR-002 V9-07) writes:
- `retailstats-YYYYMMDD.csv`
- `tldstats-YYYYMMDD.csv` (when available)

Files are never deleted. `/comps/keyword` serves from this cache with `cache_date`.
**Bots and agents are forbidden** to call the NameBio retailstats-download URL.
