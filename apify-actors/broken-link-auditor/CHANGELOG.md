# Changelog

## 0.1.0 (actor.json version `0.1`; Apify needs MAJOR.MINOR)
- First version (CR-129). Private and unpublished. No price is set in the repo (pay-per-event `result`, set on Apify).

- Redirects are followed by the runner (the client no longer follows them), so redirect chain, category and loop detection work.
- Retries only on timeouts and connect errors. List mode runs all start URLs in one batch, so maxConcurrency applies.
- `error` holds a plain reason (dns_failure, connection_refused, connection_reset, connect_timeout, tls_error, other); error rows stay uncharged. New opt-in input `debugNetwork`.

## Unreleased
- Hardening: no retry on DNS failures, TLS errors or refused connections (retries only timeouts, connection resets and 429/5xx); each crawl row is pushed (and charged as before) right after its URL is checked, so a timeout or abort keeps every checked row, and abort and migration events stop the crawl cleanly; back-off per URL is capped at about 5 s in total; unsupported schemes and unparsable start URLs go to INVALID_INPUTS (not charged), duplicates are logged; sitemap mode says when no sitemap was found. Re-angled text for migration QA, icon added, dataset schema completed. What is charged is unchanged.

## Release checklist
Only from Dvir's machine, after his OK: `apify push`, then `python3 ../tools/sync-store-meta.py` (add the actor id to its table first), then check the Store page.
