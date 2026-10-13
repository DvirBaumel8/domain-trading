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
