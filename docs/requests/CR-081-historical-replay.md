---
id: CR-081
kind: CR
status: approved
owner_bot: dom
approval: "Dvir 27 Oct 2026 (chat): replace the pick-proof with a historical replay ('take the list from 30 days ago and execute our logic, meanwhile pick randoms, then check if some of them actually sold, if yes investigate it and improve'), after a common decision with Gavriel; Gavriel agreed 27 Oct 00:50 and 00:55 IDT (DOM-TO-GAVRIEL.md)"
priority: P1
max_rounds: 2
---
# CR-081: historical replay replaces the pick-proof

## Why
The pick-proof waits 30 days per day and has had no picks since the bots paused (23 Oct). Dvir: test our logic now, on saved and historical lists, against random picks, then investigate the names that did well and improve.

## Common decision (DOM + Gavriel, 27 Oct 2026)
1. **Pick-proof off:** the daily `pickproofSeal` / `pickproofLabels` work and the pool storage stop; the days already sealed stay as archived data (the replay can score them). Gavriel pauses his pick-proof routines.
2. **Daily archive:** a compact copy of each day's GoDaddy lists (`.com` rows at $250 or less, every field, gzip JSON lines) is kept on the host's disk (not the database), for biddable auctions and closeouts (Dynadot the same way once its key is in). 20-26 Oct are already archived by DOM. `/health` (or the replay report) shows the archived days and any missing day.
3. **Replay of a saved day D:** run the current filters and score on day D's list as on that day; draw N random names from the same filtered field with a fixed seed (reproducible); look up both groups' outcomes; report precision of our top N against the randoms, with counts; list every name that did well (ours, and randoms our logic missed) with its features for a person to investigate.
4. **Outcomes, reported side by side, never merged:** (a) a later public retail sale (UnreportedSales, DNJournal, DNW), $500+ flagged: the headline; (b) auction final price $100+ (investor demand); (c) auction final price at or above our maximum (we could not have won it; reported, not a miss of the logic); closeouts: taken vs dropped by RDAP 30 days after D, labelled a weak signal.
5. **Point-in-time only:** on day D the logic uses only what was knowable on day D (the archived row's own fields, frozen lists, a lift table trained before D). No later RDAP state, sales or live lookups. A test proves it.
6. **Honest numbers:** every rate shows its counts; fewer than 20 positives is "too small to decide".
7. **Keep rule for a logic change** (Gavriel's harness): one change per replay run; kept only if expected profit rises, a paired bootstrap wins at least 80% of resamples, and no slice with 20+ buys loses more than 5%; a change that wins on auction labels but not on retail is not kept. Before each round: the pass mark, the stop condition and at most 3 rounds.
8. **D2** (Gavriel's 18,155-name list): same report shape; the sealed half stays closed until one final check.

## DVIR items
None (Dvir decided; no money, no new paid service).
