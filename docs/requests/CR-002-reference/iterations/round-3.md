# Round 3: feature refinement + variant search (DEV slice; not a test)

**Data:** round-3 slice (weeks Aug 10 + Aug 17; 45 sold, 40 dropped) **plus the original fit set**. Variants are chosen here only. Rounds 4–8 are untouched test slices.

**Features, round-3 slice (sold vs dropped)** (`iter/r3_features.txt`):

| Feature | Sold | Dropped |
|---|---|---|
| Sibling registered-share median | **0.75** | **0.15** |
| Share ≥ .5 | 64% | 38% |
| Share ≥ .6 | 60% | 30% |
| Prior history (any capture before creation) | 76% | 48% |
| Prior class **parked** | **44%** | **12%** |
| Prior class content | 16% | 15% |
| Prior class for-sale | 11% | 8% |
| Two words | **69%** | **40%** |
| ≤12 chars | 56% | 48% |
| Short (≤2 words AND ≤12) | 51% | 32% |
| Alt-ext before .com | 7% | 2% |
| Median chars | 12 | 13 |

**Features not available:** word-type detail beyond geo/tech/service/descriptive, and a CPC proxy (no free source in the time limit).

**Grid:** ~200 simple rules (share cut .3–.7 × prior required or not × alt clause × short as OR/AND/points). Each was scored by its *worst* ratio to target across the fit set and round 3 (`iter/r3_grid.txt`):

| Rule | Fit sold / dropped rej. | R3 sold / dropped rej. |
|---|---|---|
| v10 (share ≥ .5 AND prior) OR alt OR geo-form | 83% / 83% | 49% / 68% |
| **V1: share ≥ .6 OR alt OR geo-form** (prior not required) | 84% / 79% | 67% / 70% |
| **V2: share ≥ .7 OR alt OR geo-form** | 76% / 84% | 64% / 80% |
| Points (share ≥ .7, prior, alt×2, short, 2 words; ≥3) | 83% / 82% | 62% / 68% |

**Decisions:**
- **Pre-registered for testing on rounds 4–8:** v10 (baseline), V1 and V2. Nothing else.
- Requiring prior history hurts on retail data because aged originals have no capture before creation.
- Short and two-word help as tie-breakers but add little as gates once share is in.

## Addendum (after round 4; still DEV data only: fit set + round 3)

**Prior-history class** (fit sold / dropped; R3 sold / dropped):

| Class | Fit sold | Fit dropped | R3 sold | R3 dropped |
|---|---|---|---|---|
| Parked | 41% | 22% | 44% | 12% |
| Content | 35% | 8% | 16% | 15% |
| For-sale | 15% | 4% | 11% | 7% |
| None | 9% | 66% | 24% | 53% |
| Captures but never a normal page (redirect/error only) | 0% | 0% | 4% | 12% |

**V3** = share ≥ .6 AND history is not redirect/error-only, OR alt-ext-before, OR geo-form.
- Fit set: 84% sold accepted / 79% dropped rejected.
- R3: 62% / 80%, against V1's 67% / 70%.
- **V3 is pre-registered for test rounds 5–8 only.** Round 4 was already used, so V3 is not scored on it.
