# Round 12 pre-registration: three-word neighbor pattern (written 2026-10-06 ~04:04 IDT, BEFORE any test-slice scoring of these variants)

Pick slice ONLY: r10/pick.csv rows with words = 3 (36 sold / 38 dropped; expired lane of iteration rounds 2–8; already RULE-PICK).

New census pattern **bt3** (3-token names only), frozen: tokens (a,b,c) → head core (b,c) → 20 siblings from scripts/census_build.siblings([b,c]) (10 swap b, 10 swap c), RDAP registered share as of today. File: r11/bt3_sibs.json.

Candidate variants (all keep v10 unchanged for 1–2-word names and for the alt path):
- T1(k): 3-word names pass the share path if bt1 share ≥ k (and prior history), k ∈ {.10, .15, .20, .25, .30}.
- T2(k): 3-word names pass the share path if bt3 core share ≥ k (and prior history), k ∈ {.50, .60, .70}.
- T0: v10 as-is (baseline).

Mechanical pick: max Youden (sold-accept + dropped-reject) on the pick-slice 3-word rows; ties → the stricter (higher k; T1 before T2 if still tied). The picked variant is "T*". If T* does not beat T0 by ≥0.05 Youden on pick, conclusion = "no separate pattern".
Test: T0 vs T* on the r10 test slice (soldB/dropB, expired lane, 3-word rows, whatever n the Wayback runner reaches) and on the r11 aged drops (dropped side only). No other variants are scored on test.
