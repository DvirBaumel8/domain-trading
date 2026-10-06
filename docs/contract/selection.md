# Selection checks (contract v1.1.0, unreleased)

This file grows with each v1.1.0 task. It lists the statuses, codes and shapes of the selection and screening features. Routes are in `endpoints.md`.

## Name form (CAP-01): result and codes

The name-form check is pure (no network, no clock). It reads one `.com` name, a lane (`S2` geo, `S3`, `S4`, `S6`, `S7`), the word lists (with their versions) and the form settings, and returns:

`tokens` (best split), `token_types` (`city`, `state`, `trade`, `regime`, `tech`, `generic_head`, `legal`, `dictionary`, `unknown`), `alternative_splits` (up to 3 other readings that cross the best split's word boundaries and cost at most `ambiguity_margin` more), `ambiguous`, `unknown_tokens`, `word_count`, `sld_len`, `has_digit`, `has_hyphen`, `city` and `city_span`, `trade` and `trade_span`, `regime`, `keywords`, `geo_length_band` (the A-Form raw score for the SLD length), `city_plus_legal`, `short` (FORM-2: at most `short_max_words` words and `short_max_chars` characters; a preference, never a rejection), `gform1_pass` (G-FORM-1; `null` unless the lane is `S2`), `status` (`PASS`, `FLAG`, `FAIL`) and `reason_code` / `reason`.

A multi-word city from the city list (los angeles, san antonio) is **one** token when `geo_city_one_token` is true; a compound trade word (roofers, countertops) is one trade word. Only the first reason found is reported, in this order:

| Status | `reason_code` | When |
|---|---|---|
| `FAIL` | `HAS_DIGIT` | the SLD contains a digit (also for regime names such as NIS2) |
| `FAIL` | `HAS_HYPHEN` | the SLD contains a hyphen |
| `FAIL` | `UNKNOWN_TOKEN` | a run of letters is neither a word nor a city nor a listed term (`unknown_token_fails` true); `unknown_tokens` names it, a stray letter stays with its word (`cincinnatio`) |
| `FAIL` | `GFORM1_WORDS` | lane `S2` and `word_count` is above `geo_max_words` |
| `FAIL` | `GFORM1_LENGTH` | lane `S2` and `sld_len` is above `geo_max_chars` |
| `FLAG` | `GEO_ATTR_MISSING` | lane `S2`, shape within the limits, but no city token or no trade token |
| `FLAG` | `CITY_PLUS_LEGAL` | a city token and a legal term (lawyer, attorney, law) |
| `FLAG` | `AMBIGUOUS_SPLIT` | `alternative_splits` is not empty |
| `PASS` | none | none of the above |
