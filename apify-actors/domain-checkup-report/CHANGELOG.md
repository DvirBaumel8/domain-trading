# Changelog

## Unreleased
- Text only: re-angled as due diligence before buying a domain, README lists what the report contains, input descriptions, dataset schema with required keys and a view. No behaviour change.

## 0.1.1
- Every request now sends one honest User-Agent (`ApifyDomainCheckupReport/0.1`); the fake browser User-Agent on landing-page fetches is gone. A site that blocks it shows as blocked/unknown (HTTP status in the row); no retry with another User-Agent.

## 0.1
- Source moved into this repo (CR-127 Part A). No behaviour change.

## Release checklist
Only from Dvir's machine, after his OK: `apify push`, then `python3 ../tools/sync-store-meta.py`, then check the Store page.
