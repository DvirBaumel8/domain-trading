# Risk Gate codes — reject / warn / pass (buy cards)

**Owner:** Risk Gate (Shomer). **For:** Gavriel / Dvir awareness (plain codes).
**Status:** current as of 2026-11-23. Aligns with `04-buyer-current-process.md`.
**Not legal advice.** CLEAR ≠ buy approval — only Dvir's chat yes buys.

DOM is stateless and read-only. Re-run Web Risk, trademarks, and other checks on the live APIs. Do not rely on a stored result.

---

## Verdict line (what Risk Gate returns)

| Verdict | Meaning |
|---|---|
| **REJECT** | Hard fail. Do not send to Dvir as a buy option. Re-card only if the deciding fact changes. |
| **FLAG** | Soft fail / condition. May go to Dvir only with the condition written on the card (never-pitch, finish check, etc.). |
| **CLEAR** | Passes Risk Gate checks (often *with conditions*). Still needs Dvir's yes. Not approval. |

---

## AUTO-FAIL (REJECT) — plain codes

| Code | Plain rule | Auto-fail example | Pass example |
|---|---|---|---|
| **SPELL-1** | Numbers, hyphens, or spelling that is ambiguous when heard aloud. | `4roofing.com`, `roof-ing.com` | `resumedesign.com` (clear two words) |
| **BRAND-1** | SLD contains a brand / product / code name, or a one-letter typo of one (`system/bigco-names.csv` + USPTO + web). | `googlereads.com`, `amaznbooks.com` | Plain dictionary phrase with no brand token |
| **BIGCO-1** | Any word/phrase is a big-co product, model, feature, or code name launched in the **last 24 months** (Big Tech, frontier AI labs, F500, or >$10B). | `museagent.com` after Meta Muse (Sep 2026) | Generic trade phrase with no recent big-co launch hit |
| **TM-1** | Exact live mark (Registered/Filed; spaced, joined, or plural) **in a buyers' class** (classes declared *before* search) at US/EU/UK → kill. Famous marks: all classes. | `softliving.com` with SoftLiving live in home-goods classes | Exact live mark only in an unrelated class → see **TM-1-OTHER** (FLAG), not this kill |
| **TM-2** | Contained live mark recognizable as pointing to the mark owner (coined/dominant + generic affix) **in a buyers' class** → kill. | `gocloudops.com` / `cloudopsconsulting.com` with CLOUDOPS live cl.42 | Crowded dictionary word in plain meaning (e.g. applepie recipes) |
| **TN-1** | Coined / brand-like name (not plain descriptive) whose real buyers are same-name traders. Distinctive exact trade name = fail. | `steamdream.com`, `alluae.com`, personal-name+trade | Every word common dictionary; phrase describes the service; 3+ unrelated descriptive uses |
| **R-ONE / Q6** | Sale value hangs on one firm, **or** the sell plan names one firm as *the* buyer (first or alone). | Card: "pitch WashRescue first" | Multi-studio / pool plan; no single named *the* buyer |
| **§10-0** | Zero unrelated firms selling the **named** service (URL + quoted service line each). | No firm pages fetched that sell that service | 2+ unrelated firms with URL + quote |
| **3b / R-FRAME** | Fewer than **2** valid comps ≤36 months from sale date after Risk Gate re-reads source; or wrong frame (aged labeled hand-reg / P2 on hand-reg); or wrong name/date/price on a cited comp (R-DATA) even if the count still passes after fix. | One valid aged sale left after dropping a stale/self/wrong-name comp | ≥2 same-frame comps ≤36 mo, dates/prices quoted from the local sales file or URL |
| **R-FOUND** | Live mark found that meets trademark **KILL** — a missing TMview or history check never softens it to HOLD. | USPTO shows exact live mark in buyers' class; TMview still open | No kill-class mark; open EU line alone is not a kill |
| **WEBRISK-1** | Web Risk is required on every candidate (and on names we already own). A hit is a hard kill (Dvir, 23 Nov 2026). | Web Risk hit on the name | Web Risk run, source given, no hit |
| **HIST-BAD** | Bad prior life: malware / blacklist / Web Risk hit, or clear cybersquatting / brand-park history that makes the name unsafe to hold. | Blacklist or brand-park history | Clean or parking-only history (see **HIST-OPEN**) |
| **CAP-40** | Portfolio already at **40** names (POC cap). | 40 held → any new buy card | Under 40 |
| **CAP-1500** | The buy would take total spent over **$1,500**. | Spent + this price > $1,500 | Under $1,500 after the buy |
| **PRICE-250** | Ask or max we would pay is above **$250** (the code cap). Never pass. | Card max $300 | Max ≤ $250 |
| **LEN-6** | Over length/word limits (≤15 letters, ≤2 words; 3 words only with a fixed regulation token). | `aievalsconsulting.com`-style over limit when not a reg token | `resumedesign.com` (≤15, 2 words) |
| **O2 / O3 missing** | Buy card lacks O2 generic-phrase evidence or O3 TM serials/date. | Card with blank O2/O3 | O2 three-part pass + O3 serials/date on card |

---

## WARN / FLAG (not auto-fail) — plain codes

| Code | Plain rule | Warn / FLAG example | How it clears or stays |
|---|---|---|---|
| **WEBRISK-OPEN** | Web Risk was not run, returned an error, or has no source. An error or a missing source is never "clean" and cannot be CLEAR. | Check failed or skipped | Finish the check with a source → then re-verdict; a hit becomes **WEBRISK-1** |
| **B-01** | Needed break-even sale rate vs unmeasured portfolio rate. **Dvir 2026-10-22: WARNING label, not reject.** | Card needs ~1.33%/yr to break even at $1 + $22.99 renewal | Label on card; Dvir decides |
| **PRICE-40** | Price is above **$40**. Allowed only with a written case **and** Dvir's yes. Not a reject by itself if the case is on the card. | Card at $75 with no case | Written case on the card; still needs Dvir's yes; never above $250 |
| **TM-1-OTHER** | Exact live mark in **another** class at US/EU/UK (not buyers' class; not famous). | Mark in software (009) while buyers are resume studios (35/41/42) | FLAG + **never-pitch** that owner/trade |
| **TM-2-OTHER** | Contained mark live only outside buyers' class (or crowded weak mark). | Near-mark in adjacent class | FLAG + never-pitch line |
| **§10-1** | Exactly **1** unrelated firm sells the named service. | One studio only | FLAG; check that firm is not *the* buyer (R-ONE) |
| **EU-1 / UK-1 open** | TMview (EUIPO/UK) or UK IPO not run / stale — required before CLEAR. | Card cleared US only | Finish EU/UK → then re-verdict; does **not** downgrade a found TM-1 kill |
| **R-PARENT weak** | Firms may share a parent; owner lines incomplete. | Two brands, same holding company | Count as 1 until parent proof (URL) shows unrelated |
| **HIST-OPEN** | History not finished; prior parking or unread captures. | Parking 2017–2024; history still open | Condition: finish before listing **or** accept residual risk (not hard REJECT by itself) |
| **§10 padding** | Card pads buyer count with wrong-service firms (e.g. CRM tools on a coaching name). | Leads table full of adjacent trade | FLAG / drop padded rows; re-count |
| **T3 comps** | Comp is UnreportedSales (T3) in the sales file, in window. | Only T3 comps, but ≥2 in window | Mark **T3** on verdict; **not** FLAG by itself |
| **CLEAR-with-conditions** | Passes kills but carries never-pitch / B-01 / history / listing limits / PRICE-40. | `resumedesign.com` 2026-10-27 | Conditions listed; Dvir yes still required |

---

## PASS (what "CLEAR" needs)

All of the following (current rules):

1. No AUTO-FAIL code above.
2. **Web Risk run on this candidate, with a source.** A hit is REJECT. An error or a missing source is never "clean".
3. Buyer classes declared **before** any TM search; USPTO + TMview (and UK when relevant) re-run by Risk Gate — **never trust the card's TM line**.
4. TN-1 class written in one line (DESCRIPTIVE vs COINED). Descriptive: every word is common dictionary and the phrase describes the service, with 3+ unrelated descriptive uses. Coined or a distinctive trade name used by a live business fails.
5. **2+** unrelated firms selling the named service, each with URL + quoted service line; parents checked (R-PARENT).
6. Rule **3b**: ≥2 valid same-frame comps ≤36 months (or correct P2 × sale chance for aged/aftermarket); figures quoted from the local sales file or URL.
7. O2 + O3 on the card.
8. SPELL-1 / BRAND-1 / BIGCO-1 clean.
9. Under portfolio caps (40 names and $1,500 total) and length rules. Price ≤ $250. If the price is above $40, a written case is on the card (PRICE-40 condition).
10. Any FLAG items written as **conditions** (never-pitch, B-01 warning, HIST-OPEN, WEBRISK-OPEN is not allowed to CLEAR, PRICE-40, listing limits).
11. **Report to Gavriel only.** Dvir's yes is separate.

---

## Cheap check order

1. Format / SPELL / LEN / CAP-40 / CAP-1500 / PRICE-250
2. BRAND-1 / BIGCO-1 (`system/bigco-names.csv`)
3. **Web Risk** (required; hit = WEBRISK-1; error or missing source = WEBRISK-OPEN, never CLEAR)
4. Frame + comps (local sales file) — 3b / R-FRAME
5. Firm fetch + R-PARENT
6. USPTO (all forms) → TMview EU/UK
7. TN-1 / R-ONE / Q6
8. History
9. Verdict line + numbered PASS/FAIL + 2-line opinion → **Gavriel**

---

## Out of scope / process (not codes)

- The daily buy search is paused until Dvir's redesign; closeouts stay research-only. That is process from Gavriel/Dvir, not a kill code.
- CLEAR is never a bid or buy. Money actions are done only in the browser by Gavriel, each with Dvir's chat yes.
- A missing history source is HIST-OPEN, not a pass.
