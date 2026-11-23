# Buyer + Risk Gate: current process (23 Nov 2026)

**Status:** current. Written 2026-11-23 after Dvir (t1259u) asked to fix the buy-search gaps. Replaces the shortlist and auction SOPs removed when DOM went read-only (7.1.0).
**Owners:** Buyer (judgment) and Risk Gate (verdict).
**Money:** neither buys, bids, registers, lists, or messages Dvir. Cards go to Risk Gate; Gavriel asks Dvir.
**DOM:** read-only (contract 7.1.0). No discovery, shortlist, or auction routes. Until CR-115 inventory read is live, a search run is a **manual pass** over the public GoDaddy inventory files (`https://inventory.auctions.godaddy.com/`).

`.com` only.

## 0. Where names come from

- **Main line:** names already registered and for sale cheap at GoDaddy — public auctions (the main effort) and fixed-price listings.
- **Closeouts:** research only. No money and no buy card until a test shows an edge.
- **Side line:** an unregistered name, if it sounds like a paid service businesses buy. A live business on the exact name on another ending (for example `.net` or `.org`) is a plus, not a must: label `TIER-A WARN` and continue (Dvir, 16 Nov 2026).
- **Stopped (22 Nov 2026):** do not source or judge names from drop or expired lists.
- **Never:** paid catch or backorder services.

## 1. Filter order (cheap first)

Stop early on a hard fail. Report counts at each step.

1. **Tag first** (before any other research): tag local-business names (city or town + trade) and clear full person names (given + family). Drop or label tagged names before spending more effort. Every run reports `local_business_tagged_n` and `person_name_tagged_n`. If it is unclear whether a name is a person, leave it for meaning — do not tag.
2. **Cheap filters (hard kill):** easy to spell when heard; no digits or hyphens in the usual case; not a brand, product, code name, or typo of one; not an exact local-business name on the live `.com` itself; not already owned or already declined or rejected. Prefer two plain words, or one clear dictionary word.
3. **Meaning:** keep only names that could be a named paid service. Coinage, fragments, and inverted junk are out.
4. **Other endings:** if the same name is live on another ending, research the owner (what it is, size, registry) and public traffic estimates, each with a source URL, before counting it as buyer evidence. Write "no traffic data" rather than guessing. A live other ending without this research is not buyer evidence.
5. **Web Risk** on every candidate (Dvir, 23 Nov 2026), as well as on names we already own. An error or a missing source is never "clean". A hit is a hard kill.
6. **Trademarks:** USPTO and WIPO / EU TMview (and UK when relevant). Exact live mark in a buyers' class → kill. Near-marks → FLAG for Risk Gate. Declare buyer classes before any search. Risk Gate re-runs the search and never trusts the card's trademark line alone.
7. **Firms:** at least two unrelated businesses selling the named service, each with a URL and a quoted service line. Zero firms → kill. One firm → FLAG. A shared parent counts as one.
8. **Comps:** at least two valid comparable sales in the last 36 months, from the **local sales file**, with the source. Wrong frame or wrong figures → fail. A high break-even sale rate is a warning on the card, not an automatic reject.
9. **Risk Gate** independently re-checks and returns REJECT, FLAG, or CLEAR (often with conditions). CLEAR is not a buy. Report to Gavriel only. Codes and check order: `05-risk-gate-codes.md`.

Gavriel brings only CLEAR / CLEAR-with-conditions cards to Dvir. Only Dvir's chat yes, on that name and that price, is a buy.

## 2. Price and caps (one rule)

- **Per name:** prefer **$40 or less**. Above $40 only with a written case **and** Dvir's yes. Never above **$250** (the code cap).
- **Portfolio:** at most **40** names and **$1,500** total spent (the POC cap).
- Every card shows spent so far versus $1,500, and names owned versus 40.

## 3. Buy card fields

- The name, the current price, the max we would pay, and when the sale ends (if an auction).
- Why it might sell: firms with URLs and quotes; other-ending owner and traffic (or "no traffic data"); comps from the local sales file.
- The strongest reason not to buy.
- Risk checks table: trademarks, Web Risk, history, firms, comps — each DONE or OPEN. Include `TIER-A WARN` when there is no operating business on the exact `.net` / `.org`.
- How we would sell it (never one firm as *the* buyer).
- Budget left: spent versus $1,500, names owned versus 40.
- Risk Gate verdict and any conditions (never-pitch, break-even warning, open checks).

## 4. Money and roles

Money actions (buy, bid, register, renew, list, change a price) are done **only in the browser by Gavriel**, each with Dvir's own chat yes for that action. Buyer and Risk Gate never spend. DOM is read-only; it does not buy or bid.

| Role | Does | Does not |
|---|---|---|
| Buyer | Judges the list, drafts cards, sends each card to Risk Gate immediately | Buy, bid, message Dvir |
| Risk Gate | Independent verdict | Buy, bid, message Dvir |
| Gavriel | Surfaces passers (or an honest zero) to Dvir; does money actions after a yes | Self-approve |
| Dvir | Every yes | |
| DOM | Read API; later, CR-115 inventory-file reads when live | Money or write routes |

## 5. Cadence

The daily automatic search is paused. After CR-115 inventory read is live and checked, one run per day: process today's public GoDaddy files, Buyer judges, Risk Gate, Gavriel brings the cards (or zero passers) to Dvir. Until then, a run is a manual pass over those files, only when Gavriel orders it.

## Pass / fail

- Pass: a new run can follow only this file and `05-risk-gate-codes.md`: sources above, cheap-first order, Web Risk on every candidate, the one price rule, cards as specified, money only by Gavriel after Dvir's yes.
- Fail: sourcing drop lists; spending money on closeouts before a test shows an edge; treating CLEAR as a buy; bidding or buying; calling a missing or failed Web Risk check "clean"; going over $40 with no written case and Dvir's yes, or over $250 at all.
