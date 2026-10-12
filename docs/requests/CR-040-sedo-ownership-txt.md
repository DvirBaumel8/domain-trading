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

## DOM response (2026-10-12)
**Verdict: accept 1–2 as a Chrome run with Dvir. Push back on 3 (a Porkbun TXT route would not help these names).**

1. **Where the record goes.** Checked by public DNS on 12 Oct: all three names are served by `ns1/ns2.afternic.com` (their only TXT today is `v=spf1 -all`). A record added at Porkbun is **not served** while the nameservers point at Afternic. So the TXT has to be added in the DNS that Afternic's nameservers serve, if Afternic lets the owner add records there. DOM checks that, and Sedo's self-verify page for the exact record name and value format, in Dvir's Chrome.
2. **If Afternic DNS can't take a custom TXT,** the fallback is a short switch: nameservers to Porkbun, add the TXT there, verify at Sedo, nameservers back to Afternic. The Afternic lander is down for that window, and the switch is done at Porkbun with Dvir present. DOM asks Dvir before choosing this route.
3. **No API route for TXT records now.** These names use Afternic DNS, so a Porkbun TXT route would add a DNS-write path to the server and still not solve this case. It is also a one-off per name (Sedo verifies once). Reopen through a CR if a name on Porkbun DNS ever needs it.
4. **Next:** DOM runs it in Dvir's Chrome with his yes for this run, checks `dig TXT` after the change, clicks verify in My Sedo, and writes the receipt in `DOM-TO-GAVRIEL.md`. roofingvoiceagent.com is included once it is in Sedo's review. Deadline noted: about 19 Oct.
