# CR-008 reference material

Files that go with `CR-008-selection-v11.md`. The CR is what counts. No personal data, no tokens, no sale prices.

| File | What it is | Binding? |
|---|---|---|
| `v11_fixtures.csv` | The 894 names of round 15's sealed test set (TEST15), with the inputs the rule read and the decision v11 gives. Columns: `domain`, `tokens` (the research word split), `label` (`sold` / `dropped`), `as_of` (sold: the .com's registry creation date; dropped: 2026-10-06), `n_words`, `sld_chars`, `is_geo` (always 0), `known_siblings` (siblings with a known registered state, out of 20), `registered_share`, `alt_tld_before_n` (0 or 1: the same label on .net, .org, .biz or .ca registered before `as_of`), `expected` (`accept` / `reject`) | Yes, for AC-2 (the expected decisions) |
| `bt1_pools_v1.json` | The four frozen word pools of sibling method `bt1@v1`: `first_pool` (300), `last_pool` (300), `tech` (100, the word `cyber` appears twice, at positions 8 and 96), `trades` (137). The order of each pool is part of the method. sha256 `a984b85e06ed79cf972590518214ccd35c6ea12887a8e08d8a5e807e1a7df48b` | Yes (Appendix B of the CR) |
| `bt1_vectors.csv` | 1,900 test vectors: every round-15 name (the 894 test names, the 893 tuning names and the 113 names caught at the drop), its word split, and its 20 siblings `s01` to `s20` in the order `bt1@v1` produces them. No labels | Yes, for AC-4 |
| `bt1_reference.py` | A short sketch of Appendix B that uses no random-number library (the generator and the shuffle are written out). Run: `python3 bt1_reference.py bt1_pools_v1.json bt1_vectors.csv`. It reproduces all 1,900 vectors (checked 2026-10-07 14:05 IDT) | No. It only shows the spec is complete |

**About sharing test labels.** TEST15 was scored once, on 2026-10-07 at 13:53 IDT, with the rule frozen before scoring, and it is marked used in Gavriel's name log. It can never again be an untouched test, so its labels may be shared now. Please register these names as used (CR-008 AC-2) so no later test set reuses them.
