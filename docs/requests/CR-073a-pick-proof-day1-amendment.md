# CR-073a — Pick-proof day-1 amendment (2026-10-21, sealed before results)
Per Challenger grade challenge/answers/pick-proof-day1-grade-2026-10-21.md. Day 1 (audit aud_c1e1ca9248c9cfe13e279c15784d13b7, sealed:false) is **void and restarted** under this amendment.

1. **Plan in use:** bot-pick-proof-plan.md sha256 `a0d62702db09dbbf09762c89be988e7f669b0f1afb01c177e674d658f20f1c93` (not 059e73ea).
2. **Pool (plan line 20):** live **GoDaddy closeouts plus Dynadot** listings, .com, ≤$40, from the **06:00 IDT snapshot**. Same pool for every arm (A, A-v12fix, B1, B2, C1, C2).
3. **K1:** 2-word rule only (allowed, plan line 31). K1 code arm_a.py sha256 `2844923d9501fe34129a15ee413a652c3f2ea243e2a307acbe3e038b022a1ac9`. Primary test renamed: "v12 ranking within the 2-word pool".
4. **Arm A:** frozen v12, score_v12.py sha256 `4ac02ee31c8806d7f5a90dbb153ba53361ea48efc642e388a62cde5830a6031c`. Not changed.
   - **Defect log:** 75/100 day-1 picks had `wc_known=False` (word_count missing). The wc_known=False share is reported daily.
5. **New arm A-v12fix:** the fixed model (word_count imputation, price-neutral rank), same pool and day, own sha recorded at day 0. Separate from A.
6. **Request to DOM:** state the pool-hash recipe in a non-code doc (exact input bytes, ordering, fields, snapshot file). Challenger could not reproduce pool_sha256 `80ccb789…` from the 10-19/10-20 GoDaddy files.
7. **Seal:** daily line in docs/requests/pick-proof-seals.md, committed to GitHub before 19:00 IDT.

## Addendum (2026-10-21 10:45 IDT, Gavriel)
- K1 code sha accepted as `a0e86235bd84b28c...` (arm_a.py with Dynadot added), replacing `2844923d`, which can't be reproduced because the file was edited in place. From now on, every code change gets a new file name or a commit before use.
- Day 1 restart: group A audit `aud_109426e85547adb6ec2daceff4205182` (100 picks: 93 GoDaddy, 7 Dynadot) replaces `aud_c1e1...`.
- Pool sha `80ccb789...a98e8d`: DOM froze it at the Oct 20 15:00 UTC save (129,996 names), not the 06:00 snapshot. This is a recorded deviation from plan line 20.
- Dynadot came from data/raw/dynadot/2026-10-21/upload_closeouts.json (manifest 169414b0), because /snapshots caps at 1,000 rows.
- wc_known=False on 75 of the 100 picks. The A-v12fix arm hasn't been submitted for day 1.

## DOM answer (2026-10-21 08:20 UTC)
**Item 6 done in v5.30.0** (tag pushed; the Mac host deploys after CI; please confirm on `/health`).
- **Recipe (non-code doc):** `docs/internal/pickproof.md`, section "Pool-hash recipe". It names the input file and how its data date is set, the item filters, the Dynadot rows, the exclusions, the order, the exact bytes hashed and the seed.
- **Why `80ccb789…` could not be rebuilt from the GoDaddy files:**
  1. The pool of D uses the file the server downloaded at 15:00 UTC on D-1. A copy taken at another time (06:00 IDT) can differ, because GoDaddy rewrites the file. Compare your zip's SHA-256 with `sources.godaddy.manifest_sha256`.
  2. The server also drops items with `isAdult: true` or no valid `auctionEndTime`.
  3. Names with a stored sale or a sold market episode are removed. That list was server-only until now.
  4. Dynadot closeouts of D-1 are included when that upload is sealed. A tie on price keeps the Dynadot row (the internal doc said GoDaddy; fixed, G-117, no code change).
- **New check without the files:** `GET /pickproof/{date}/pool` (READ or bots) returns the frozen rows `[domain, source, price_cents, passes_k1, is_two_word]` in hash order. SHA-256 of `JSON.stringify(rows.map(r => r.slice(0, 3)))` = `pool_sha256`. It also replaces the 1,000-row `/snapshots` view as the way to read the full pool. The manifest now lists `sources.excluded_sales_graded` for days frozen from today on. For 2026-10-21 (frozen before the release), the pool call is the check.

**On the other items (no server change needed; say so if you want one):**
- **Item 2 (06:00 IDT snapshot):** the server has no 06:00 snapshot. Its pool of D is the frozen 15:00 UTC D-1 save, and B1, B2, C1 and `NOT_IN_POOL` all use it. Your addendum already records this as a deviation. I recommend making the server's frozen pool (`GET /pickproof/{date}/pool`) the plan's pool from day 2, so every arm has the same pool by construction.
- **Item 3 (K1 = 2-word only):** the server's B2 is still the old K1 (closeout filters passed). Your new K1 sub-pool corresponds to the server's two-word flag (`is_two_word`, the C1 sub-pool): letters only, at most 10 letters, exactly two words, not SPELL-1. arm_a.py may split words differently; the `is_two_word` column lets the Challenger compare name by name.
- **Item 5 (A-v12fix):** the server stores and grades only arm A. A-v12fix lives in your seal line and files; `/pickproof/report` will not grade it. If you want it graded on the server (picks, seal, T30 labels, report), file it as a CR item.
- **Files under `docs/requests/pick-proof/` (`*.py`):** kept, because they are your timestamp witness and nothing in the service reads or runs them. Founder rule 11 keeps code out of this repo, though. From now on, please commit only the SHA-256 in the seal line, and keep the scripts in your own repo.

## Gavriel confirm (2026-10-21 08:10 UTC)
- `/health` shows **5.30.0**. Release confirmed live.
- `GET /pickproof/2026-10-21/pool`: 200, 129,996 rows (GoDaddy 125,395, Dynadot 4,601). My SHA-256 of `JSON.stringify(rows.map(r => r.slice(0, 3)))` = `80ccb7898b4d753fef8efdb5f0716ac96313d2c7d0891b3f8bc5bb8663a98e8d`, equal to `pool_sha256`. **Item 6 closed.**
- Item 2: accepted. From day 2 (2026-10-22) the plan's pool is the server's frozen pool (`GET /pickproof/{date}/pool`); every arm, A-v12fix included, picks from it. The Oct 21 deviation stays recorded.
- Item 3: noted. 5,841 rows have `is_two_word = true`; the Challenger compares by that column.
- Question: `passes_k1` is false on all 129,996 rows for 2026-10-21. Is that expected (old K1 = closeout filters, and the pool was frozen before them), or a bug? If a bug, file it as a BUG item; no rush, B2 is not graded on day 1.
- Item 5: no server change for now. A-v12fix stays in my seal lines.
- Scripts: agreed. From now on only the SHA-256 goes in the seal line; the scripts move out of this repo. The two `.py` files already committed stay as the timestamp witness.
