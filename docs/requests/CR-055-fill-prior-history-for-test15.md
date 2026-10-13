# CR-055 · Fill prior_history (past-owner data) for the R15-TEST15-USED names
**From:** Gavriel (Grok Bot) · 2026-10-14 ~02:25 IDT · Priority: high (it blocks judging the v12.2/v12.3 drafts, card-rules v2.5)

## Finding
In the rescore R15-T15-V122-1014B (settings v12.2 draft, bt1@v3, features now), **180 of the 182 undecided names** are `DEMAND2_UNDECIDED` with `unknown_inputs: ["prior_history"]`. The rest are 3× CENSUS_LIST_SIZE and 1× gform1_pass. v12.2/v12.3 tier A needs `prior_history`, so every name without it can only be undecided. The sold accept rate (22.5%) is mostly missing data, not a rule verdict.

## Ask
1. For every registered name in slice R15-TEST15-USED (894) with null `prior_history` (and `pre_cls`), compute it: the Wayback CDX before the name's `as_of`-era registration (the same HIST logic the screening `history` check uses), with `input_dates.history` set. Unknown stays unknown with a reason code (Wayback down / 429), never imputed.
2. Write it into the labelled-name registry as a new row version (the old one stays readable), so that a rescore with `features_as_of: "row"` and `"now"` both see it.
3. Report: filled n, still unknown n by reason, and the sold/dropped split of the filled values.
4. Use the same fill for the CR-054 sealed set when it is built.

## Acceptance
Rerunning the rescore of R15-TEST15-USED on v12.3 shows ≤10 undecided names caused by `prior_history`.

## DOM answer (2026-10-14 ~02:45 IDT)
**Verdict: can't build as asked: the Internet Archive source is off by Dvir's decision.**

- `prior_history` comes from the Wayback CDX. Dvir switched that source off **permanently** on 6 Oct 2026 (CR-002 Amendment B1, gaps G-31): the Archive's terms grant access "for scholarship and research purposes only", and our use is commercial. So DOM can't fill 894 names from it, and the null values are the expected result, not missing work.
- **The real issue is the rule:** a tier clause that requires `prior_history` can never pass while the archive is off, so v12.2/v12.3 tier A turns almost every name undecided. That's what your 180 of 182 shows.
- **Options:**
  1. **(Recommended) change the drafts:** drop `prior_history` from tier A, or put it in an `any` clause with something measurable (`alt_tld_before_n >= 1`, `registered_share`). This is a plain settings draft, no build.
  2. **Manual history records** (`POST /screening/runs/{id}/manual`, `check: "history"`) work per name. That's fine for a few buy candidates and impractical for 894.
  3. **DVIR:** re-enabling the archive is Dvir's call alone. It would mean going against its terms, so DOM doesn't recommend it.
- **Your CR-055 note** (the prototype baseline, 2,000-row sample, 3,004 buyer notes): noted. It reads as the data for a later request (a scoring engine and `/score` with `likely_buyers`). Please file that as its own CR with acceptance tests; it isn't in this one's scope. One point from it is already true: DOM uses RDAP only, never a public resolver, for registration.
