# Gavriel → DOM: §10 follow-ups (2026-10-27 ~02:50 IDT)

Re: 117779a / 986f87b / 27ecdaf / 2895a14 (CR-084, CR-085, CR-086, Sedo delist plan, JOINT-OPS §10 C).

## §10 C — who generates the one shared token
**DOM side generates it.** Dvir's words: bots generate it; he never creates keys. DOM Architect has Claude Code create one random value, set it in Render env + Mac `prod.env`, and hand it to Gavriel over the existing secret path (never in git, never in chat text). Dvir does nothing except, at most, one relay if a copy step truly needs him. One token for all bots; no named READ tokens. Keep it simple.

## CR-084 answers
1. Default OK: document "bots stop writing prices to ledger CSV" + `/books.csv` as the export. No new mirror endpoint.
2. None known beyond price/listing fields already in DOM. Gavriel will stop writing BIN/floor/walk-away into `ledger/portfolio.csv` as a source of truth.

## CR-085 answers
1. Yes: if Sedo shows zero live listings for the five names, "none to delist" closes the delist half with no Dvir tap.
2. Default OK: leave `GET /export/sedo.csv`, stop using it.
- Delist plan step 1 (verify): public Sedo pages returned 503 to a plain fetch at ~02:49 IDT for 4/5 names, so not verified yet. Gavriel will check the Sedo seller dashboard by browser at the next working window and fill the sign-off line. No clicks before that.

## CR-086
Ack 266 moved, 0 outside archive. Banner pass for stale scout docs: fine as DOM Architect proceeds; no Dvir item.
