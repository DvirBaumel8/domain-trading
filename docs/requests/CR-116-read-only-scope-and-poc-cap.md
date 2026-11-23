# CR-116: CR-114 and CR-115 are read-only; Web Risk on candidates; $1,500 total cap

**From:** DOM Architect, passing on Dvir's answers to DOM's held points (DOM-TO-GAVRIEL, 23 Nov 18:45). Gavriel relayed them from Dvir's chat at about 16:37 Israel time on 23 Nov 2026. Gavriel will add Dvir's exact chat lines below under "Dvir's words".
**To:** DOM (Claude Code).

## Decisions
1. **No money or write routes.** Money actions stay as they are today: Gavriel does them by hand in the browser, with Dvir's yes in chat for each action. From CR-114 and CR-115, drop register, renew, bid and buy. **The approval-file idea is cancelled** (`docs/requests/approvals/` and the `money` reader flag). Afternic listing and price writes, and set-nameservers, are held too until Dvir says otherwise. Founder rules 1, 11 and 12 and the write-route ban stay as they are.
2. **Web Risk in `/check` for any name** we are considering buying, plus our own names. This CR-114 point replaces the "own names only" limit in CR-113 R-2. An error, timeout or missing key is never "clean".
3. **Founder rule 2 gets the POC total:** 40 domains **and $1,500 total spend**, plus $250 a name. Put it in `src/state.ts` and in `npm run check-state` (total spend in the ledger is at most 150000 cents), and write it in the founder rules.
4. **Render keys:** `JOB_TRIGGER_TOKEN`, `APP_ENV` and `PUBLIC_BASE_URL` are deleted with Dvir's yes. Gavriel is removing them in the Render dashboard and will confirm. `GOOGLE_WEB_RISK_API_KEY` and the Porkbun keys stay.

## Build (read only)
- Web Risk in `/check` (point 2 above).
- Porkbun owned-domain read: expiry, auto-renew, nameservers and lock.
- GoDaddy Domains read (`GODADDY_DOMAINS_PAT`, read scope): expiry, auto-renew, nameservers and lock for `mineunited.com` and `promptinjectionaudit.com`.
- Afternic: read our listings and our sales (`AFTERNIC_API_KEY`, `AFTERNIC_API_SECRET`).
- USPTO TSDR status by serial number (`USPTO_API_KEY`).
- GoDaddy public inventory files on request: streamed and paged, never stored, with no size cut.

- GoDaddy Auctions **reads only** (`GODADDY_API_KEY`, `GODADDY_API_SECRET`, classic `sso-key`): auction lookups for buy search, as in CR-115 point 4, which Dvir approved at 16:30. No bid or buy call exists in the code.

Rules for every route: GET only. A missing key, an error or a 403 eligibility code is shown as an error and is never "clean", "ok" or an empty result. Keys are never logged or returned. Update the contract, the code map and the tests in the same commit.

## Keys
Gavriel is creating them now, read-only where the site allows it, under Dvir's yes (16:34 Israel time). Until a key is in Render, its route must report the source as missing.

## Done when
A tagged release is live. `/check` shows a Web Risk result, or an explicit error, for a known-clean name. Each read route returns real data once its key is set, or an explicit "missing". The new tests pass, including the never-clean-on-error test and the $1,500 cap in check-state.

## Dvir's words
Dvir's answers in the Grok Bot chat with Gavriel, 23 Nov 2026, about 16:37 Israel time (answer card t1257s5859), verbatim:
- פעולות שעולות כסף: "כסף נשאר כמו היום, בדפדפן עם כן שלי על כל פעולה"
- בדיקת Web Risk: "Web Risk על כל שם ששוקלים לקנות"
- תקרת $1,500 בכללי היסוד: "לכתוב את תקרת $1,500 בכללי היסוד"
- למחוק 3 מפתחות ישנים ב-Render: "למחוק את JOB_TRIGGER_TOKEN, APP_ENV ו-PUBLIC_BASE_URL ב-Render"

Earlier the same day (16:30 Israel time, t1254u), approving CR-115: "להעביר כל מה שאפשר בקוד בחינם בבקשה / כמובן לבדוק הכל אחר כך כמו שצריך ולעדכן את תמונת המצב של החברה". Key creation (16:34, card t1257s5854): "כן, תיצור את כל 4 המפתחות".
