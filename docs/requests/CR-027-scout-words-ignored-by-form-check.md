> Status: open. Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT.

# CR-027: scout `words` are ignored by the `form` check and the tier's `n_words` (v3.3.0, CR-022 A)
| Field | Value |
|---|---|
| CR id | CR-027 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-09 IDT |
| Priority | **P1**: it blocks both names CR-022 A was built for |
| Based on | Live API v3.3.0: intake 25 and 26 (`words` sent, 200 accepted), on-demand screen queue run `run_8e2b4574-504b-40ea-a611-b19e0f8a67cd`, screening run `run_a8cffb08-90d7-48f4-a29e-21e23a405df6` (settings v11.3). No src/ or tests/ read. |

## What happens
- **ukcbamcompliance.com** (intake 25, `words: ["uk","cbam","compliance"]`, S6):
  - `form` FLAG `AMBIGUOUS_SPLIT` with tokens uk·cb·am·compliance;
  - `tier` inputs `n_words: 4`, so tier L is false (max 3 words) → FAIL `DEMAND2_FAIL`, even with `sellers_verified_n: 4`.
- **aievalsconsulting.com** (intake 26, `words: ["ai","evals","consulting"]`, S3):
  - `form` FAIL `UNKNOWN_TOKEN` "Not a word, city or known term: als" (tokens ai·ev·als·consulting, word_count 4);
  - `tier` UNKNOWN (n_words and sld_chars null), even with `sellers_verified_n: 5`.
- **The words aren't shown either:** both names show `words: null` and `split_source: null` on the screening run.
- **Only the census used the scout words:** its siblings were yourcbamcompliance.com and chatbotevalsconsulting.com.

## What the contract says (CR-022 A, endpoints.md intake)
"every word rule then runs on these words instead of the dictionary split". The words should also appear on the entry as `words` plus `split_source: scout`.

## Ask
1. When an intake row has `words`, use them for the `form` tokens, `word_count`/`n_words` and `sld_chars`, and for `form` checks of unknown tokens (a scout word should count as a known term for that name). Show `words` and `split_source` on the run and the list.
2. Re-screen intake 25 and 26 once fixed (or tell us how; see CR-026). Both already have fresh tm_us, history and sellers records.

## Acceptance
Intake 25 → form PASS, n_words 3, tier L. Intake 26 → form PASS, n_words 3, sld_chars 17, tier L. Both pass price under v11.3 (EV +$15.50).
