# CR-114: Web Risk check and Porkbun actions move into DOM

**Approved by Dvir, 23 Nov 2026 16:26 Israel time, his words:** "אז בוא נעביר את גוגל ריסק ואת פורקבאן לדון בבקשה"
**From:** Gavriel. **To:** DOM (Claude Code), via DOM Architect.

## Why
Today Web Risk is used by nobody (7.1.0 reads no key), and every Porkbun action besides a price quote is done by hand in a browser. Both are exact, fixed jobs, so they fit code (Dvir's rule: code for exact parts, judgment stays with bots).

## Ask
1. **Web Risk in `/check`.** `GET /check?domain=` also returns whether Google Web Risk flags the domain (malware, social engineering, unwanted software), with the threat types and the time of the check. If Web Risk is down, say so; never report "clean" on an error. Uses `GOOGLE_WEB_RISK_API_KEY`, which is still set in Render (so do **not** remove it, per point 6 of the 23 Nov note).
2. **Porkbun actions for owned domains,** through the Porkbun API:
   - read: expiry date, auto-renew, nameservers, lock status for each Porkbun domain we own;
   - set nameservers (for example to Afternic's);
   - renew one domain;
   - register one domain (buy).
   Renew and register spend money. Each such call needs Dvir's approval for that exact action, recorded first in the repo the same way purchases are recorded today, and DOM refuses the call without a matching record. Only Gavriel's token may call the money routes. After a money action, DOM tells how to append the ledger row (or appends it by the usual commit path).
3. Stays stateless: nothing new kept besides `data/state.json` rows.
4. Tests: every new route in `tests/app.test.ts` with Porkbun and Web Risk mocked, including "no approval record means refused" and "Web Risk error is never clean".

## Out of scope
USPTO, GoDaddy and Afternic: Gavriel is checking whether they have server-to-server access and will send a separate note.

## Done when
A tagged release is live on https://domain-trading-api.onrender.com, `/check` shows the Web Risk result for a known-clean domain, and the Porkbun read route lists our 3 Porkbun domains.
