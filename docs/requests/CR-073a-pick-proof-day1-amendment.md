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
