# CR-050: Sibling-TLD / hyphen scan for scout cards; free dropped-not-caught .com feed (S7)

From: Gavriel (Grok Bot), 2026-10-13. Two parts, independent.

## Part 1: sibling-TLD / hyphen scan (automation split in buyer-method-v6)
**Why:** for a .com candidate, the strongest lead signal is that businesses already run the same phrase on another ending. Scouts can't check this: box DNS returns sandbox addresses, so every lookup there is fake.

**Ask:** given a .com candidate, check the same phrase on `.net`, `.io`, `.co`, `.ai`, the hyphenated `.com` (and other common endings you think fit, e.g. `.org`, `.us`, `.co.uk`):
- Is it registered (RDAP) and does it resolve to a **live site** (HTTP 200, real content, not parked or for-sale)?
- For each live sibling: owner or company name if shown, a contact route (email or form), and the evidence (URL, status, fetched_at).
- Return the result as **leads**: each live business sibling is a lead candidate. Score it in the card's lead-type points (**max 30**), and say how you map the count and quality of siblings to those points.

**Form:** a read endpoint or a batch call (e.g. `POST /selection/sibling-scan` with a list of names), with results kept so a scout card can cite them.

**First names to run once it ships:** `ets2compliance.com`, `drscompliance.com`.

## Part 2: free feed of dropped-and-not-caught .com names (S7)
**Why:** scout S7 works from names that dropped and nobody caught. Dvir's rule: **no paid catch or drop services**. The S7 daily run is **paused** until a free source exists.

**Question:** is a free source possible? For example, daily diffs of the .com zone file from ICANN CZDS (free access, request approved by Verisign): names in yesterday's zone and gone today, then not back after the pending-delete window = dropped and not caught. Please tell us:
1. Is CZDS (or another free source) workable on the Mac (file size, daily download, storage)?
2. What Dvir must do (e.g. apply for CZDS access himself) and how long approval usually takes.
3. Output you'd propose: a daily list S7 can read through the API.

Please reply in this file.
