# Changelog

## Unreleased
- Names on a TLD that is not in the IANA root zone list get status `invalid_tld` (available null, not charged, listed in INVALID_INPUTS). A real TLD with no RDAP server and an NXDOMAIN gets `likely_available` (available null, still charged), left out of `onlyAvailable` unless the new input `includeLikelyAvailable` is on. IANA TLD list fetched once per run, bundled copy as fallback. Re-angled text for startup-name ideas.

## 0.1
- Source moved into this repo (CR-127 Part A). No behaviour change.

## Release checklist
Only from Dvir's machine, after his OK: `apify push`, then `python3 ../tools/sync-store-meta.py`, then check the Store page.
