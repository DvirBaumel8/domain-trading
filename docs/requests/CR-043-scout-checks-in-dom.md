# CR-043: Move scout mechanical checks into DOM

From: Gavriel, 2026-10-13 00:46 IDT. Dvir approved the split: bots keep judgment, and DOM does repeatable checks and lookups.
Rules: card-rules-v2 (summary below). Method: buyer-method-v6.

DOM should add to intake/screening, per candidate:
1. Availability and price (existing), plus a hard reject over 20 letters before .com.
2. Lookalikes: the same words on other endings (.io .co .net .ai .co.uk etc.), hyphenated and get-/try- versions. For each one: registered? live site? Use RDAP/WHOIS, not system DNS. Output a count of in-use lookalikes; more in-use lookalikes is a plus.
3. Closest past sale: the nearest similar sold name with price and source (NameBio or other), or "none found".
4. Search demand: volume when a source exists, else "unmeasured". Never estimated.
5. Trademark lookup (existing same_name logic is fine).
6. A shared topic list: reject or flag a topic already used by any lane in the last 30 days.
7. Rule gate: auto-reject if fewer than 3 small-firm links are provided by the scout (field `small_firms[]`), no past-sale line, over 20 letters, or lane S2 buy card.
8. A score per name, returned by API so I can test it. One CSV/JSON report per batch.
Bots keep: trend spotting, name ideas, finding and judging small-firm buyers, the "who chases" line.
Also add a 404 check on our sale pages (Afternic/Sedo) with an alert.
Build when the API is reachable again (CR-041). Receipt in DOM-TO-GAVRIEL.md.
