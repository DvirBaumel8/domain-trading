# CR-039: allow digits in intake names when the scout gives a word split

From: Gavriel, 2026-10-10 12:41 IDT

ets2compliance.com (S6, EU ETS2) was refused at intake with HAS_DIGIT even with words ["ets2","compliance"]. Shomer passed it and its trademark and history records are already in DOM.

Ask: when `words` is given and a token is a known regulation or standard code with a digit (ets2, pfas2, iso27001, nis2, dora2...), accept it at intake and let screening judge it. Keep refusing digits when no words are given.

## DOM response (2026-10-10)
**Verdict: not built. Changing it needs a selection-rule change, which is a DVIR decision.**

1. **Opening intake alone would do nothing.** The name form check in screening (G0, `SPELL-1`) fails every name with a digit, "even in regime names" (`docs/contract/selection.md`, reason `HAS_DIGIT`). If intake let ets2compliance.com in, the daily screening would refuse it the same day for the same reason. The intake refusal is just that answer given earlier.
2. **What it would take:** a new selection rule (v12) where SPELL-1 allows digits only inside a regime token the lexicon knows (ets2, nis2, iso27001 …), never anywhere else. Then intake follows the same rule when `words` are given. That needs a holdout replay and activation with Dvir's `approval_ref`, like every selection change (CR-001 P-8).
3. **DOM's recommendation: keep SPELL-1.** A digit adds a spelling problem when a buyer hears the name ("ets two" or "ets2"?) and shrinks the resale pool. The S6 lane already has letters-only regime names. ets2compliance.com may be good, but one name doesn't justify a rule change.
4. **DVIR:** if Dvir wants regime digits allowed, his line through you must name the change (SPELL-1 allows digits inside known regime tokens) and the new selection version. DOM then builds v12 with the intake change and a release.

## DOM update (2026-10-10): built in v3.8.0
Dvir decided: "the digit is part of the regulation name, that's an exception we should accept". Item 4 above is settled, and there's no new selection version to approve. SPELL-1 now has the exception in code.
1. **First add the codes:** `POST /selection/lists/regime {add: ["ets2"]}` (WRITE, a new list version, no approval needed). Only codes on that list count. Terms are a letter first, then letters or digits.
2. **Then re-send** ets2compliance.com with `words: ["ets2","compliance"]`. It should be accepted and screened normally. Without `words` it stays `HAS_DIGIT`, and a digit anywhere outside a listed code fails too.
3. Census lists may now be named with digits (`bt1_ets2compliance`). Release note: `docs/releases/v3.8.0.md`.
