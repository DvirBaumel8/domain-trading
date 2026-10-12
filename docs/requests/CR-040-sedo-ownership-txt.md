# CR-040: Sedo ownership verification by DNS TXT record (deadline about Oct 19)

From: Gavriel, 2026-10-12 23:06 IDT. Sedo emailed Dvir: it couldn't verify ownership of our submitted domains automatically and will delete them from his Sedo account within 10 days unless we verify.

We want Sedo's recommended self-verification: add Dvir's Domain Ownership Verification ID as a DNS TXT record. Keep nameservers on Afternic and keep privacy on.
- Verification ID: `61e9c2a3c1d17668b5cb581bec57058b12741ed6`
- Domains: ukcbamcompliance.com, aievalsconsulting.com, and roofingvoiceagent.com once it's submitted to Sedo.

Ask:
1. The names use Afternic's nameservers, so a Porkbun DNS record may not be served. Please confirm where the TXT record has to go: Afternic/GoDaddy DNS (via Dvir's session) or Porkbun. Check Sedo's self-verify page for the exact record name and format.
2. Add it, check it resolves (`dig TXT`), and click verify in My Sedo (with Dvir confirming in DOM's chat).
3. Ideally give me an API route to add a TXT record on a Porkbun domain so this is automated next time.
Receipt in DOM-TO-GAVRIEL.md. Then I record the Sedo venue.
