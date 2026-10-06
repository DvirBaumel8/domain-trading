# data/

Committed reference data for `src/screening/lexicon.ts`. Rebuilt only by DOM, with network, via `npx tsx scripts/build-wordlists.ts` (never run by tests or by `src/`). Source terms: `docs/internal/sources.md`.

| File | Source URL | Licence | Retrieved | Lines | Bytes | sha256 |
|---|---|---|---|---|---|---|
| `wordlists/en-scowl-60.txt` | ESDB/SCOWL custom list, size 60, US spelling, variant level 1, no specials, diacritics stripped (`http://app.aspell.net/create?max_size=60&spelling=US&max_variant=0&diacritic=strip&download=wordlist&encoding=utf-8&format=inline`; ESDB git revision 1e5b7d3, 24 Jun 2026) | Kevin Atkinson permission notice, `wordlists/LICENSE-SCOWL.txt` | 2026-10-06 | 88,853 | 827,834 | `f0cfeea97b8f58aa60648f938bdc5bb2594541d883691ac2328561281423e791` |
| `wordlists/us-places.txt` | Census 2026 Gazetteer, National Places (`https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_place_national.zip`) | US Government work, 17 U.S.C. 105, `wordlists/LICENSE-CENSUS.txt` | 2026-10-06 | 32,080 | 469,704 | `7ef121fd6e97bacfcf54165537cdea2b8706da4aa788df7db4b3ced741b8b2bc` |
| `wordlists/LICENSE-SCOWL.txt`, `wordlists/LICENSE-CENSUS.txt` | as above | - | 2026-10-06 | - | - | - |

Total of the two data files: 1,297,538 bytes (plan cap 1.5 MB).

Formats: `en-scowl-60.txt` is one lowercase a-z word per line (length >= 2, sorted, unique). `us-places.txt` is `name<TAB>STATE_USPS<TAB>WORDS`, one line per name/state/word-count triple, names lowercase letters only (`losangeles`, `stlouis`); `WORDS` is how many words the real name has (`Los Angeles` = 2), so a multi-word city can be a single token or not (`geo_city_one_token`).
