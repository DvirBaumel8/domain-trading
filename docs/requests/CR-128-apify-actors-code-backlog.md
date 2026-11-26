# CR-128: Apify actors' code backlog (from Gavriel's audit)

**Status:** Backlog, filed 26 Nov 2026. **Start only after CR-127 Part A is merged.** **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
Each item ships with tests and a version bump in `actor.json`. Publishing to Apify needs Dvir's OK on each release.

1. **Sitemap URL Extractor:** default `maxUrlsPerSite` is 1000 when left empty. Gavriel already changed `main.py` locally, so it lands with the CR-127 import. Also set `default: 1000` in `input_schema.json` and add a test for the empty-input default.
2. **All 4 actors:** mark the main input `required` in `input_schema.json`:
   - `domains` for checkup, DNS and availability
   - start URLs for sitemap
   
   The empty-input clear-failure path stays in place, with tests.
3. **SSL expiry** on Domain Checkup Report and Bulk DNS & Email Auth Checker. Add new output fields `ssl_expires_at` (ISO), `ssl_days_left` (int) and `ssl_issuer`, plus `ssl_error` when port 443 doesn't answer or the TLS handshake fails. Use a short timeout so it never blocks the run. Update the dataset schema, and add tests with a mocked socket.
4. **Bulk Domain Availability Checker:** never charge rows whose status is `unknown`. Users get those rows free. The test checks that the charge count equals the number of rows with a known status.
5. **WHOIS fallback** on availability, for when RDAP has no server for the TLD or returns an error. Fall back to port-43 WHOIS on the TLD's server and parse the "not found" patterns. If that also fails, the row is `unknown` (and free, per item 4). Use only free sources; there are no paid WHOIS APIs. Add tests with recorded WHOIS replies for at least `.com`, `.io` and `.co.il`.

Bots handle the text changes these need (README, field descriptions) after each item lands.
