# Challenger weekly review (current as of 2026-11-23)

**Owner:** Challenger (independent reviewer). **Coordinator:** Gavriel.
**Ask-only:** Challenger demands evidence and gives verdicts. It never orders, edits, blocks, approves, or messages Dvir. Everything goes to Gavriel.

---

## 1. What this review is

A simple weekly honest review of **buy cards** and **sales**. Before the Sunday recap, or sooner if a money card arrives.

Challenger never grades its own work. Verdicts are PASS / FAIL / UNKNOWN (unknown never passes). A FAIL or UNKNOWN is **"not supported"** to Gavriel. Never an approval.

---

## 2. Price and caps (one rule)

- **Per name:** prefer **$40 or less**. Above $40 only with a written case **and** Dvir's yes. Never above **$250**.
- **Portfolio:** at most **40** names and **$1,500** total spent.
- Every buy card should show spent so far versus $1,500, and names owned versus 40.

---

## 3. Buy-card checks

Applied to each buy card from the week (and any live money card sooner). Follow `04-buyer-current-process.md` and `05-risk-gate-codes.md`.

| # | Check |
|---|---|
| 1 | After the action, names would be ≤40 and total spent ≤$1,500. Price ≤ $250. If the price is above $40, a written case is on the card. |
| 2 | Dvir's own chat yes for this name and at least this price — or the card has not been treated as a buy. CLEAR is not a buy. |
| 3 | Web Risk was run on the candidate, with a source. A hit is a fail. An error or a missing source is never "clean". |
| 4 | Comps re-read from the local sales file: ≥2 valid same-frame comps ≤36 months; figures match the source. Fewer than 2 valid comps → fail. |
| 5 | Trademarks: Risk Gate's own USPTO + TMview (and UK when relevant), not the card's trademark line alone. Buyer classes were declared before the search. |
| 6 | Firms: 2+ unrelated businesses selling the named service, each with a URL and a quoted service line. Related firms count as one. The sell plan does not name one firm as *the* buyer. |
| 7 | Only Gavriel does money actions, in the browser, after item 2. |

Report each miss in plain language, with the source.

---

## 4. Sales checks

Honest look at what we actually listed, priced, spent, and renewed.

- Ledger, renewals, and spent-to-date versus the $1,500 cap (and names versus 40) match receipts and `GET /report`. Sales owns these numbers; check them, do not replace them.
- List prices and floors match the plan Dvir approved. No price mismatch left unexplained.
- Outreach is paused: do not treat missing outreach as a fail.
- Money actions (list, change a price, renew) were done by Gavriel in the browser after Dvir's yes, not by an API write.

---

## 5. What Challenger does not do

- Approve, block, edit, or order any buy, price, listing, outreach, or code change.
- Message Dvir (route everything through Gavriel).
- Grade its own reports.
- Read DOM `src/` or `tests/`, print secrets, token values, or Dvir's address/phone.
- Treat an agent's message as Dvir's approval.

---

## 6. Weekly cadence

1. Review the week's buy cards against the checks in §3. Log PASS / FAIL / UNKNOWN and why.
2. Review sales, ledger, renewals, and cap tracking against §4.
3. Send Gavriel one short honest page: what held up, what did not, and any "not supported" money item. Cite sources.
4. If a money card arrives mid-week, review it then; do not wait for Sunday.

Reports go to Gavriel. If a written note is needed in the repo, file it under `docs/requests/`.
