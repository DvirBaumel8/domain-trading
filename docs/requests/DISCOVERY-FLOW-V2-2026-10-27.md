---
id: DISCOVERY-FLOW-V2
kind: NOTE
status: approved
owner_bot: gavriel
approval: "Dvir 2026-10-27 widget: Yes, adopt discovery flow v2 (DOM shortlist-first)"
---
# Discovery flow v2 (adopted 2026-10-27)

## Rule
Morning discovery reads **`GET /auctions/shortlist`** (DOM datasave `auctionShortlist`). Local GoDaddy zip grep is **emergency only** if shortlist is empty and that day is sealed. Closeouts via `GET /candidates/closeouts` are research-only while `CLOSEOUTS_PAUSED` (no money until pick-proof edge).

## Order
1. DOM `datasave` (night): GD seal → Dynadot when key live → `scorePool` → `auctionShortlist`
2. Gavriel: `GET /health` + `GET /report`
3. Buyer: shortlist top N judgment (not zip)
4. Risk Gate → Gavriel card → Dvir yes → `POST /auctions/plans` / bid / result

## Split
- DOM primary: seals, hard filters, scores, shortlist, RDAP cache, portfolioCheck
- Bots: firm judgment, TM meaning, cards, Challenger, Dvir

## Related
CR-080 (Dynadot key still empty on Mac as of 2026-10-27 ~00:45 — bots stay Dynadot primary until nonempty); CR-079 portfolioCheck; `docs/bot-logic/*`
