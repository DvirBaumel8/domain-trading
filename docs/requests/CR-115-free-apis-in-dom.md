# CR-115: Free Afternic, GoDaddy and USPTO access moves into DOM

**Approved by Dvir, 23 Nov 2026 16:30 Israel time, his words:** "להעביר כל מה שאפשר בקוד בחינם בבקשה / כמובן לבדוק הכל אחר כך כמו שצריך ולעדכן את תמונת המצב של החברה"
**From:** Gavriel. **To:** DOM (Claude Code), via DOM Architect.

## Why
CR-114 already covers Web Risk and Porkbun. The remaining external systems that have a free, server-to-server path should move into DOM the same way: exact, fixed jobs in code; judgment stays with bots; no paid plan and no paid data source.

## Ask
Free only. If a path needs a paid plan or paid data, leave it out and say so.

1. **Afternic Portfolio API** (https://api.afternic.com/docs/portfolio-api/, open to all sellers since 22 Oct 2026; 150 req/min; up to 2 keys from the account Security settings).
   - read our listings;
   - add, update or remove a listing, and patch Buy It Now price.
   Writes are only to apply a price or listing change that Sales decided **and** Dvir approved, via the same per-action approval-file pattern as CR-114 (one file under `docs/requests/approvals/`, single use, expiry at most 7 days, Gavriel's token only). The file holds Dvir's words with date and time, the action, the domain, the change (for a price: the BIN in cents), and the expiry. The server refuses unless every field matches the call. DOM returns a record; Gavriel files it.

2. **GoDaddy public inventory files** (https://inventory.auctions.godaddy.com/ `metadata.json`, `closeout_listings.json.zip` and the other public files; no login). Download in code for buy search. DOM stays stateless: process on request or stream; do **not** store market history in the DB (Dvir, 16 Nov: the DB keeps only owned domains and their money/sales records). `data/state.json` stays limited to those owned-domain and money/sales rows.

3. **GoDaddy Domains API** (free with the account): read-only status of our domains still at GoDaddy (expiry, auto-renew, nameservers, lock). This also answers the pending check that auto-renew is OFF for `mineunited.com` and `promptinjectionaudit.com`.

4. **GoDaddy Auctions API** (open since 13 Aug 2026 to Auctions members; we already pay the $4.99 membership; Classic `sso-key`). Read-only auction lookups. Bid and buy calls only behind the CR-114 approval-file pattern, with a max price in cents. The code enforces the $1,500 total spend and 40-domain caps (`spent_cents` plus the quote or bid). Single use: a retry must not pay twice. Only Gavriel's token may call bid or buy. DOM returns the ledger row (approval file as `approval.ref`); Gavriel files it.

5. **USPTO TSDR** status lookup by serial number only (free key, 60/min), as a helper for Risk Gate. **Not** word search (there is no official API; Risk Gate keeps using the website). Skip bulk XML indexing (it conflicts with the stateless DB).

## Keys
DOM must not create keys. Gavriel will create them in the box browser later, only after Dvir's separate OK, and they go into Render only after that yes. Until a key is set, the route must say the source is missing or in error, and must never report "clean" or "ok".

Proposed env names (confirm or rename, and write the final list into the contract):

| Source | Env names | Notes |
|---|---|---|
| Afternic Portfolio API | `AFTERNIC_API_KEY` | Add a secret var if the API needs two parts |
| GoDaddy Domains API | `GODADDY_API_KEY`, `GODADDY_API_SECRET` | Free with the account. Do not reuse the old unused `GODADDY_PAT` name |
| GoDaddy Auctions API | same pair if Classic `sso-key` is the same credentials; otherwise `GODADDY_AUCTIONS_API_KEY` and `GODADDY_AUCTIONS_API_SECRET` | Say which in the contract |
| USPTO TSDR | `USPTO_API_KEY` | Name used in older docs. Status by serial number only |
| GoDaddy public inventory files | none | No login |

## Rules (same contract as CR-114, applied here)
- Never report "clean" or "ok" when a source errors, times out, or a key is missing.
- Approval files are committed by bots under `docs/requests/approvals/`. The server reads the deployed repo, so an approval only works after a deploy. Write the exact file format into `docs/contract/endpoints.md`.
- Single use without new state: refuse when a ledger row already cites that approval file, and refuse a bid/buy that would pay twice or exceed the caps.
- Only Gavriel's reader (`"money": true` in `data/access.json`, per CR-114) may call listing writes, bid or buy. Read routes stay open to every reader.
- Stays stateless: nothing new kept besides `data/state.json` rows for owned domains and their money/sales records.

## Out of scope
Anything paid. Word-mark search at USPTO. Bulk USPTO XML indexing. Storing auction or inventory history.

## Tests
Tests are the contract. Every new route in `tests/app.test.ts` (APIs mocked), including: no approval record means refused; a used approval is refused; a bid/buy over the caps is refused; a non-Gavriel token is refused on writes; a source error or missing key is never "clean" or "ok"; inventory handling does not write market history into state.

## Done when
A tagged release is live on https://domain-trading-api.onrender.com, the new routes are in the contract, and the tests above pass. Live checks against the real APIs wait until the keys are in Render (Dvir's separate OK). Then: Afternic lists our listings; GoDaddy Domains shows expiry, auto-renew, nameservers and lock for `mineunited.com` and `promptinjectionaudit.com`; inventory files can be processed on request; TSDR returns status for a known serial or an explicit error.
