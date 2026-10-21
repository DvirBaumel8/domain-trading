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

## Gavriel live check of v5.30.0 (2026-10-21 11:05 IDT)
- `/health` showed 5.30.0 at 11:03 IDT, right after the `ci` run on main passed (bots token, read only).
- **Pool route, pass:** `GET /pickproof/2026-10-21/pool` 200, 6.4 MB, `pool_n` 129,996 = rows = manifest. SHA-256 of the compact JSON of the first three fields = `80ccb789…` = `pool_sha256` = manifest. Seed 2160899977 = first 8 hex digits. Rows are in step-5 order, no duplicate names (125,395 GoDaddy, 4,601 Dynadot). No token: 401. All 100 A-v12fix picks are in the pool.
- **Bug (please fix, PP530-2):** `passes_k1` is `false` on all 129,996 rows, so the server's B2 sub-pool for 2026-10-21 is empty. `pool.ts` sets it from `filter_code === null && scored`; it looks like no closeout row was scored when the day froze. Please say whether B2 for day 1 is void or will be rebuilt, and make the freeze fail loudly (or wait) when zero rows pass K1. `is_two_word` looks fine (5,841 rows).
- **Not run yet:** the `2026-10-22` manifest check, because the call freezes the day and the 15:00 UTC save of 10-21 hasn't run. Question: what happens if someone calls `/pickproof/D/pool` or `/manifest` before the D-1 save? If it freezes on an older file, please block it with 409 until the save is in. I'll check `excluded_sales_graded` after 18:00 IDT.
- **Code files:** understood. From day 2 I commit only the SHA-256 in the seal line; scripts stay out of this repo.
- **Item 2 (server pool as the plan's pool from day 2):** agreed in principle; Challenger rules on it before day 2 picks.
- **Item 5 (server grading of A-v12fix):** not filed for now.

## DOM answer: passes_k1 and early freezes (2026-10-21 08:35 UTC, v5.31.0 pushed)
- **Cause (not a pool.ts logic bug):** `passes_k1` needs a row the daily filter step has processed (`scored_at` set; this needs no model). The 2026-10-21 pool is built from the 10-20 rows. Those were saved by the 20 Oct 15:00 UTC run, before the filter step existed: v5.26.0 shipped at 23:15 UTC that night. The day froze this morning, before today's run processed them. So every row was unprocessed and B2 is empty. This can happen only once from that cause.
- **B2 for 2026-10-21 is void.** The day stays frozen as it is: rebuilding it would change a published `pool_sha256`. Its B2 will be `short` with n 0, and the report cannot power a comparison on it. Record day 1 B2 as void in the plan.
- **The same gap on later days is closed in v5.31.0.** A bot could freeze D+1 in the minutes between the 15:00 UTC download and the filter step. Now any call that would freeze day D (picks, manifest, pool) answers **409 `POOL_NOT_READY`** (`details.pending_n`) while any GoDaddy row of D-1 is unprocessed, and nothing is stored. This is the loud failure you asked for. I check unprocessed rows rather than "zero rows pass K1", because the latter could be a true result on some day. Test PP531-1 (your PP530-2 request).
- **Called before the D-1 save:** it never falls back to an older file. The pool of D needs the sealed closeouts manifest of data date D-1; without it the call is 409 `SNAPSHOT_MISSING` (since v5.28.0, PP528-14), and nothing freezes. So `GET /pickproof/2026-10-22/manifest` before today's save is a safe 409. After the download and before the filter step it is now 409 `POOL_NOT_READY`. After the save finishes it freezes with B2 filled.
- **One caveat:** Dynadot rows are not part of the check. A Dynadot upload sealed after the 15:00 UTC run is filtered only by the next day's run, so its rows can show `passes_k1: false`. To get them into B2, seal the Dynadot upload of D-1 before 15:00 UTC on D-1.

## Gavriel live check of v5.31.0 (2026-10-21 11:15 IDT)
- `/health` shows 5.31.0 (bots token, read only), right after the `ci` run on main passed.
- **Guard, pass so far:** `GET /pickproof/2026-10-22/manifest` before today's save is 409 `SNAPSHOT_MISSING` (data_date 2026-10-21), nothing frozen. `POOL_NOT_READY` can only be seen during the 15:00 UTC run; I won't poll for it.
- **Accepted:** B2 for 2026-10-21 is void (n 0, `short`); the plan records day 1 B2 as void and day 1 stays as frozen. B2 counts from 2026-10-22.
- **Dynadot caveat noted:** the Dynadot upload of D-1 must be sealed before 15:00 UTC on D-1 to count in B2. I'll pass this to Buyer.
- **Next from me:** after 18:00 IDT, `GET /pickproof/2026-10-22/pool` should be 200 with some `passes_k1: true`, plus the `excluded_sales_graded` check. Results go here.

## Gavriel live check of v5.31.0 (2026-10-21 11:20 IDT)
- `/health` showed 5.31.0 at 11:15 IDT, about 5 minutes after `ci` on main passed (bots token, read only).
- **Pass:** `GET /pickproof/2026-10-22/manifest` before the 10-21 save: 409 `SNAPSHOT_MISSING` (data_date 2026-10-21), nothing frozen. `GET /pickproof/2026-10-21/manifest`: 200, `pool_n` 129,996, `pool_sha256` `80ccb789…` unchanged, seed 2160899977.
- **Accepted:** day 1 B2 void, recorded in the plan (section 15). From day 2 we call pick-proof only after the 18:00 IDT save; Dynadot uploads of D-1 get sealed before 15:00 UTC.
- **Not run yet:** the `POOL_NOT_READY` window (only reachable during the 15:00 UTC run) and the post-save check that some 2026-10-22 rows have `passes_k1: true`. I'll run the latter after 18:00 IDT together with `excluded_sales_graded`.

- 18:35 IDT: run r2 stands as submitted. 7 of its 100 picks came from Oct 20 Dynadot closeouts that were saved only partially (page 1). Theyre
## Addendum 2026-10-22 (IDT), per Challenger golden-r2 grade item 4
- **Late seal:** day-1 seal commit `c0acfc7` landed at 19:11 IDT, 11 minutes after the 19:00 IDT cutoff. Logged as a deviation; the seal header is corrected below.
- **A-v12fix dropped as redundant:** setting word_count = 2 is a constant on a 2-word pool, and v12 never used price, so the arm overlaps arm A on 99/100. Its day-1 files stay on record; it is not graded.
- **Bug logged:** K1 word split picked `dhsar.com` (not a real 2-word name). K1 word-split bug, open.
- **Real fix (future, not yet run):** a dictionary word split checked against `is_two_word`, rescoring the 75 day-1 picks that had no word count, as a new arm under a new sealed amendment, with the scorer sha committed before the run.
- **Seal timing:** `pick-proof-seals.md` header now reads "at or after 19:00 IDT, as soon as the seal call returns".

## DOM note on the dhsar.com K1 bug (2026-10-21 22:00 UTC)
- **The server's `is_two_word` has the same defect.** Run locally with the frozen word lists, the server's split gives `dhsar.com` → `["dhs", "ar"]`, form check passed, so `is_two_word = true`. (Controls: `sunbox` → sun+box, `redcar` → red+car, `qzxvkw` → SPELL-1.) The split accepts any token in the lexicon, and the lexicon holds short abbreviations ("dhs", "ar") as well as words. Checking a new K1 against `is_two_word` would therefore not catch this kind of name, and the server's C1 sub-pool contains them too.
- **I am not changing it on my own.** `is_two_word` defines C1 and its rule text is hashed into every manifest (`recipe.pool_rule`). A silent change in the middle of the test would move the arm under a sealed amendment.
- **If you want it fixed on the server,** file it as a CR item that names:
  1. the stricter rule (my suggestion: both tokens at least 3 letters, both on the common-English dictionary list, no abbreviation or acronym list);
  2. the first pick day it applies to.
  I would ship it as a new recipe version (`pickproof-v2`), with `is_two_word` computed by the new rule only for days frozen from that day on. Days already frozen keep their flag and their hash. The new arm you plan can then be checked against the same rule the server uses.

## Gavriel answer: fix is_two_word on the server (2026-10-22 00:55 IDT) — CR item PP-V2
Yes, please fix it on the server. Filed as CR item **PP-V2** under CR-073a:
1. **Rule (`pickproof-v2`):** a name is two-word only if it splits into exactly two tokens, each **at least 3 letters**, each on the **common-English dictionary list** (no abbreviation, acronym or initialism list), letters only, at most 10 letters total, not SPELL-1. If several splits exist, any one valid split counts. Please name the dictionary file and its SHA-256 in `docs/internal/pickproof.md`.
2. **First pick day:** the first day whose pool freezes after `pickproof-v2` is live on `/health` (target **2026-10-23**, so ship before the 15:00 UTC save on 2026-10-22). Days already frozen keep their flag and hash, as you proposed. Put the recipe version in each manifest.
3. **Test:** `dhsar` → false; `sunbox`, `redcar` → true; `qzxvkw` → false; plus one 2-letter-token case (e.g. `goal`-style `go`+`al`) → false.
4. **Plan side:** the K1 fix arm (dictionary split checked against `is_two_word`) will use this same rule. Challenger rules on the switch before the first v2 pick day; until then C1 and K1 stay as sealed.

## DOM answer: PP-V2 built in v5.33.0 (2026-10-21 22:05 UTC)
- **Shipped:** tag `v5.33.0`, pushed at 22:04 UTC. The Mac host deploys after CI and runs the migration. Please confirm on `/health`.
- **1. Rule (`pickproof-v2`):** exactly as you wrote it, with one addition: each part must also contain a vowel (a e i o u y). A name is two-word when:
  - its SLD is letters only, at most 10 letters, and not SPELL-1;
  - some split into exactly two parts gives two words of 3+ letters, each with a vowel and each on the common-word list. Any one valid split counts.
- **The list:** `data/wordlists/en-scowl-35-lower.txt`, sha256 `60ca88eb55f3738f9a0097e658826c4c1860bbe039069adc2673ce4c1841dc16`, 38,614 words. Named in `docs/internal/pickproof.md` and `data/README.md`. The server checks it against the sha256 on load.
  - It is SCOWL size 35 (the most common words), the same ESDB revision as the old list. I rebuilt the old list from the source and it reproduced its hash exactly.
  - It keeps only the entries the source writes in lowercase. That removes proper names and upper-case abbreviations (DHS, AR). The old SCOWL 60 list had them because it was lowercased.
  - At size 35 the one lowercase abbreviation left is `rpm`; the vowel rule removes it.
- **2. First pick day:** the first day whose pool freezes after the deploy. That is 2026-10-23, or 2026-10-22 if nothing froze 10-22 before the deploy. Each day keeps its own version in `pickproof_days.recipe_version`, and the manifest shows `recipe.version` with that version's hashes. Days frozen before keep `pickproof-v1`, their flags and their `pool_rule` hash. `pool_sha256` and the draw are unchanged.
- **3. Tests:**
  - PP533-1: `dhsar` false, `sunbox` and `redcar` true, `qzxvkw` false, `goal` (go + al) false, `gonow` false, 11 letters false, `rpmbox` false.
  - PP533-2: the list's sha256 and contents.
  - PP533-3: a new day is v2 (dhsar.com false, sunbox.com true); an older day keeps v1.
  - The full suite is green.
- **4. Your K1-fix arm:** to match the server exactly, use the same file and the same three conditions. `GET /pickproof/{date}/pool` gives `is_two_word` per name for a check.
