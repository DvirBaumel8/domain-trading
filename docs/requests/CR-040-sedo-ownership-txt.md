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

## DOM update (2026-10-12): the route, and who does what
**What I found:**
- **Sedo's record:** TXT, host `@`, value = the verification ID (Sedo's own help; a CNAME variant also exists).
- **Afternic's nameservers serve no custom records.** Afternic's help only covers adding *its own* TXT at the registrar's DNS, and owners report they can't add a TXT at Afternic; the fix they use is a short switch of nameservers.
- **The three names are at Porkbun.** Porkbun keeps a name's DNS records even while its nameservers point elsewhere, so the TXT can be added in advance and the switch kept short.

**Plan (about 1–3 hours off the Afternic lander per name; listings stay up):**
1. **DOM (Dvir's Chrome, Porkbun signed in):** add TXT `@` = `61e9c2a3c1d17668b5cb581bec57058b12741ed6` on the three names at Porkbun DNS. If Afternic's Settings → Ownership Verification shows a TXT for us, add that too, so Afternic's own check holds while the nameservers are away.
2. **Gavriel (API):** for each name, `POST /list/{domain}` with `lander: "custom"` and `ns` = Porkbun's default nameservers (check the exact host names on Porkbun's page for the name: `*.ns.porkbun.com`). Dry run first.
3. **DOM:** `dig TXT` until the ID shows, then click verify in My Sedo (Dvir signed in).
4. **Gavriel:** once Sedo shows the names verified, `POST /list/{domain}` with `lander: "afternic"` to switch back. `/report` will show nameserver warnings in between; that's expected.
roofingvoiceagent.com joins once it's submitted to Sedo. Receipt in `DOM-TO-GAVRIEL.md`.

## Gavriel follow-up (2026-10-13 01:28 IDT): Dvir's yes, please do step 1 now
Dvir approved at 01:28 IDT, in his words: "Yes, do the Sedo verification this week". That includes the short nameserver switch to Porkbun and back.

1. **DOM, now (Dvir's Chrome, with his yes for this run):** add TXT host `@`, value `61e9c2a3c1d17668b5cb581bec57058b12741ed6`, at Porkbun DNS for ukcbamcompliance.com and aievalsconsulting.com, plus roofingvoiceagent.com. Note: by your receipts only the first two have been submitted to Sedo so far. Add roofingvoiceagent.com's record too, so it's ready once it's submitted; tell me if you submit it in the same run. If Afternic's Ownership Verification shows a TXT for us, add that too.
2. **Receipt** in `DOM-TO-GAVRIEL.md` (which names have the record, and the exact Porkbun nameserver hosts for each name). Tell Dvir there when you'll need him signed in at Sedo for the verify click.
3. **Gavriel, after the receipt:** step 2 one name at a time (`POST /list/{domain}`, `lander: "custom"`, Porkbun nameservers, dry run first). Then you run `dig TXT` and verify at Sedo, and I run step 4 (`lander: "afternic"`) right after each name verifies, before moving to the next name.
No nameserver change has been made yet. Deadline about Oct 19.

## Gavriel status check (2026-10-13 14:15 IDT)
Still no step-1 receipt in `DOM-TO-GAVRIEL.md` or here. Live DNS check from my box can't see Afternic TXT (proxy), so I can't confirm the Porkbun record myself.

Please reply in this file:
1. Are the Porkbun TXT `@` records already added for ukcbamcompliance.com and aievalsconsulting.com (and roofingvoiceagent.com if submitted)?
2. If not, what are you blocked on (Dvir signed in to Chrome / Porkbun / Sedo)?
3. Exact Porkbun nameserver hostnames for each name once the TXT is in, so I can dry-run `POST /list` for step 2.

Sedo's Oct 11 mail still says deletion within 10 days of listing (~Oct 19). I'm asking Dvir for Chrome time today so you can run step 1 while he is present.

## DOM status (2026-10-13)
1. **Not added yet.** In Dvir's Chrome on 13 Oct (about 01:50 IDT), DOM filled the TXT record at Porkbun but did **not** submit it: Porkbun's "Submit Records" also **switches the nameservers to Porkbun's** for every name submitted (its own warning). Porkbun serves records only on its nameservers. So the TXT and the nameserver switch are one step, and it takes the Afternic lander off each name until it is switched back.
2. **Blocked on Dvir's choice:** either (a) the switch window (submit at Porkbun, wait for Sedo, and SellerHub when its key is in, to verify, then switch the nameservers back to `ns1/ns2.afternic.com` at Porkbun, the same day), or (b) Sedo's manual verification from the Porkbun invoice, with no downtime. DOM asked him in chat.
3. **Porkbun's nameservers:** the switch sets Porkbun's current defaults itself (the old `maceio/salvador/fortaleza/curitiba` set is retired). You don't call `/list` for the window: the switch and the switch back both happen at Porkbun in Dvir's Chrome, so `/report` will show nameserver drift for a few hours. That is expected.
