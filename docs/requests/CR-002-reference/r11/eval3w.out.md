bt3 coverage on pick 3-word: 74/74
pick 3-word sold: median bt3 core share 0.85 (n=36); median bt1 0.10
pick 3-word dropped: median bt3 core share 0.90 (n=38); median bt1 0.05

| Variant | Pick 3-word: sold acc. | dropped rej. | Youden | Pick all expired: sold acc. | dropped rej. |
|---|---|---|---|---|---|
| T0 (v10) | 9/36 = 25% | 38/38 = 100% | 1.25 | 70/103 = 68% | 42/75 = 56% |
| T1(0.10) | 25/36 = 69% | 21/38 = 55% | 1.25 | 86/103 = 83% | 25/75 = 33% |
| T1(0.15) | 17/36 = 47% | 22/38 = 58% | 1.05 | 78/103 = 76% | 26/75 = 35% |
| T1(0.20) | 15/36 = 42% | 30/38 = 79% | 1.21 | 76/103 = 74% | 34/75 = 45% |
| T1(0.25) | 12/36 = 33% | 32/38 = 84% | 1.18 | 73/103 = 71% | 36/75 = 48% |
| T1(0.30) | 12/36 = 33% | 36/38 = 95% | 1.28 | 73/103 = 71% | 40/75 = 53% |
| T2(0.50) | 35/36 = 97% | 0/38 = 0% | 0.97 | 96/103 = 93% | 4/75 = 5% |
| T2(0.60) | 31/36 = 86% | 1/38 = 3% | 0.89 | 92/103 = 89% | 5/75 = 7% |
| T2(0.70) | 28/36 = 78% | 2/38 = 5% | 0.83 | 89/103 = 86% | 6/75 = 8% |

Picked T* = T1(0.30) (Youden 1.28 vs T0 1.25); beats T0 by ≥0.05: False

| Variant (TEST) | Test 3-word expired: sold acc. | dropped rej. | Test all expired: sold acc. | dropped rej. | Aged drops 3-word w/ archive: rej. |
|---|---|---|---|---|---|
| T0 (v10) | 3/14 | 23/23 | 22/36 | 27/40 | 1/1 |
| T1(0.30) | 3/14 | 23/23 | 22/36 | 27/40 | 1/1 |
