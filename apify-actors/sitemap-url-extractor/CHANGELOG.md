# Changelog

## Unreleased
- Inputs are validated before any request: bad start URLs go to INVALID_INPUTS (not charged), a modifiedSince that is not a date fails the run at once, and a network failure logs 'could not connect (reason)' instead of 'HTTP None'. Re-angled text, dataset schema with required keys and a view.

## 0.1
- Source moved into this repo (CR-127 Part A). No behaviour change.

## Release checklist
Only from Dvir's machine, after his OK: `apify push`, then `python3 ../tools/sync-store-meta.py`, then check the Store page.
