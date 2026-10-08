> Status: Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT (customer may send DOM fix and feature requests without asking Dvir each time). The approach is Dvir's own decision of 2026-10-08 16:50 IDT (below). Real backorders spend money, so they stay OFF until Dvir's own approval line turns them on (R-6).

# CR-019: backorders for expiring .com names (approve days ahead, catch at the drop)
| Field | Value |
|---|---|
| CR id | CR-019 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-08 16:55 IDT |
| Dvir's decision | 2026-10-08 16:50 IDT, in chat, verbatim: **"Approve days ahead"**. This means expiring names are approved by Dvir 2 to 5 days before they drop, then backordered at a catch service. We never auto-buy them. |
| Authority to send | Dvir's standing rule, 2026-10-08 16:42 IDT: Gavriel may send DOM fix and feature requests without asking Dvir each time. Dvir still decides buying, selling, spending and rule changes. |
| Priority | P1 for C-1 to C-3 (fix today's intake: shape filter, timeout retry, pending delete is not "taken"). P1 for B-1 to B-8 built with real backorders OFF. Turning real backorders ON is Dvir's call (R-6). |
| Based on | Live API 2026-10-08: `GET /candidates/daily` after rebuild at 16:46 IDT showed `screened_today: 30`, `failed_by_check.availability: 27`, `failed_by_check.form: 1`, `unknown_by_reason.TIMEOUT: 2`, 0 candidates (see CR-018). Gavriel's research note on catch services (2026-10-08). API and contract docs only. No src/ or tests/ read. |

**Kind of change:** a new business flow (backorders) plus three intake fixes, each with the behavior we expect and pass/fail tests. How to build it is DOM's choice. Route and field names are suggestions.

## 1. Business need
- Most of today's 30 drop-list names were checked after they had already dropped. Other investors catch good names within seconds of release, so 27 were already taken. Waiting for Dvir's approval after a name frees up loses every good name.
- **The .com timeline:** an expired .com spends 5 days in "pending delete" with a fixed drop date, and then it drops. A backorder is a standing request at a catch service: "if this name drops, register it for me". It is free to place, and you pay only if the service catches the name.
- **Dvir's decision:** he approves expiring names 2 to 5 days before their drop date, in his normal daily message, and DOM then places a backorder. DOM never buys or backorders a name on its own.
- **Service: DropCatch, through its API.** Why DropCatch:
  - It is the strongest .com catcher.
  - It charges only on a catch: $59 per .com if we are the only backorder, first year included.
  - If 2 or more customers backordered the name, there is a 3-day auction among them, starting at $59.
  - Its API (api.dropcatch.com, v2) covers placing, listing and cancelling backorders, auctions and bids, history, and a download of upcoming drops. It has no sandbox, so every real call is live.
  - Dynadot was considered as a backup, but it is weak on .com and is not part of this CR.
  - GoDaddy no longer sells backorders.

## 2. Rules

### Part C: intake fixes (needed even before backorders)
- **R-C1 (shape filter first):** DOM applies the same shape/form check the scouts use to its own pulled drop lists **before** screening. Names that fail shape are dropped at intake with the reason, and do not use screening or registry lookups.
- **R-C2 (timeout retry in the same run):** when the availability/registry lookup for a name times out, DOM retries it later **in the same run** (after the other names, with a short backoff) instead of dropping it for the day. Only after the retries fail is it reported as `unknown` / `TIMEOUT`, with the number of tries.
- **R-C3 (pending delete is not "taken"):** a name whose registry status is `pending_delete` (or `redemption`) is reported as **"dropping on <expected_drop_date>"**, not as failed availability / taken. It goes on a backorder track (R-1). Only a name registered by someone else and not on its way to drop counts as taken.

### Part B: backorders
- **R-1 (backorder candidates):** the daily list can include `.com` names in pending delete whose expected drop date is 2 to 5 days after the list date. They pass the same picking, trademark and history checks as any other candidate. Names that drop before Dvir's next answer can be acted on are left out, with the reason.
- **R-2 (what Dvir sees):** each backorder candidate is marked as a backorder, not a buy, and shows:
  - the expected drop date
  - the last safe time to place the backorder
  - the service (DropCatch)
  - the fee if no one else wants the name ($59 today; a setting, not hard-coded)
  - a suggested top price
- **R-3 (approval):** a real backorder may only be placed for a name Dvir approved, with **his top price for that name**. DOM keeps a reference to that approval (the same way buys reference his line).
- **R-4 (placing):** after approval, DOM places the backorder at DropCatch and confirms it was accepted. If DropCatch refuses it (for example "not in pending delete status"), the name is marked `failed_to_place` with DropCatch's message, and it shows in `/report`.
- **R-5 (after the drop):** a daily step syncs results from DropCatch. The statuses are: `placed`, `failed_to_place`, `left_pending_delete` (restored or sold elsewhere), `caught` (sole, fee charged), `in_auction`, `won`, `lost`, `cancelled`.
  - In an auction, DOM bids **only up to Dvir's top price** for that name.
  - DOM never bids above that price, and never bids on a name without approval.
- **R-6 (switch, default OFF):** real backorders and real auction bids sit behind a switch that is **OFF by default**. Only Dvir's own approval line can turn it on, the same way settings activation and the buy hold work today.
  - While it is off, everything runs in `dry_run`: requests are built and validated and nothing is sent to DropCatch.
  - The current buy hold, `/buy` dry_run only, and "Dvir approves every real buy" all stay as they are.
- **R-7 (caps):** DOM enforces a **per-name top price** (from Dvir's approval) and a **monthly backorder cap** (money committed and spent).
  - Both values are TBD by Dvir, so they are settings with no money default. If no cap is set, real backorders cannot run even with the switch ON.
  - A call that would pass the cap is blocked and reported. DOM never splits or shrinks it on its own.
- **R-8 (missed deadline):** if an approved name has no accepted backorder by its last safe time, DOM alerts in `/report`.
- **R-9 (caught names):** a caught or won name joins the portfolio with its cost, catch date and registrar (DropCatch/NameBright).
  - The usual for-sale page and listing jobs run on it. That needs nameserver changes at that registrar.
  - Note the 60-day transfer lock after any new registration.
- **R-10 (secrets and health):** DropCatch credentials live only as env vars on the service. `/health` shows backorders as configured or not, and the switch as on or off, without showing any values.
- **R-11 (calls):** every backorder write follows the existing rules: Bearer auth, an Idempotency-Key, and an audit row. Placing the same name twice is safe (idempotent, never a second order).

## 3. Acceptance criteria (via the API)
- **T19-1 (C-1):** upload a drop list with names that fail shape. They are removed at intake with the shape reason and are not counted in `screened_today` or availability lookups.
- **T19-2 (C-2):** when a lookup times out, the name is retried later in the same run. The run summary shows how many timeouts were then resolved and how many stayed `TIMEOUT`, with try counts.
- **T19-3 (C-3):** a pending-delete name on the daily screen shows as "dropping on <date>" (with `expected_drop_date`), not in `failed_by_check.availability`.
- **T19-4:** `GET /candidates/daily` lists backorder candidates with drop date, last safe time, service, fee and suggested top price. A name dropping in under 2 days or over 5 days is left out with a reason.
- **T19-5:** creating a backorder with no Dvir approval reference, or no top price, is refused.
- **T19-6:** with the switch OFF, a create returns a dry-run result (`dry_run: true`, nothing sent to DropCatch), and `/health` shows the switch off.
- **T19-7:** with the switch ON but no monthly cap set, a real create is refused with a clear code.
- **T19-8:** a create that would pass the monthly cap is refused and reported. A bid above the name's top price is never sent.
- **T19-9:** creating the same name twice with the same Idempotency-Key returns the first result, and a second key for the same name does not make a second order.
- **T19-10:** list and cancel work. After the drop, each backorder shows one of the R-5 statuses, and `/report` shows caught, lost, in auction and money against the cap.
- **T19-11:** an approved name with no accepted backorder by its last safe time raises a `/report` alert.

## 4. Open questions for DOM
1. **What do you need from us to connect DropCatch?**
   - The exact env var names (we suggest `DROPCATCH_CLIENT_ID`, `DROPCATCH_CLIENT_SECRET`).
   - Does the DropCatch API need an IP allow-list, and if so, which fixed outbound IP(s) does the Render service use?
   - Anything Dvir must set up in the DropCatch account (API client, payment method, a first login)? Dvir opens the account himself, and the secrets go in through the secure secret request, never in chat.
2. Which rules do you expect to meet, and do you push back on any, with the reason?
3. How will Dvir's approval line for a backorder name (with its top price) be recorded and referenced: the same mechanism as buy approvals, or a new one?
4. Can the upcoming-drop data come from DropCatch's drop download instead of, or alongside, the current drop lists? Which do you prefer for the drop date?
5. For R-C2, what retry count and backoff will you use, and does the retry stay inside the run's time budget?
6. How will you test the DropCatch calls without a sandbox (recorded responses, dry-run path only)? No real backorder may be placed during testing.

<!-- DOM writes below this line -->
