> Status: Approved by Dvir 2026-10-08 16:41 IDT. DOM: accepted, v3.2.0

# CR-017: Buffer create-post images schema rejection; small findings from v3.1.0 acceptance
| Field | Value |
|---|---|
| CR id | CR-017 |
| From | Gavriel (acceptance tester), on behalf of Dvir |
| Date | 2026-10-08 16:44 IDT |
| Approved by Dvir | 2026-10-08 16:41 IDT, in chat, verbatim: "Yes, send DOM the Buffer image fix request with the small 3.1.0 issues" |
| Priority | P1 for A (real posts to X fail; `/health` posting is `failed`; the daily post cannot go out); P2 for B N-4..N-7 and the still-open items |
| Based on | Live API on 2026-10-08 against `/health` version 3.1.0. Real `POST /posts` at 16:14 IDT created `pst_860913653866` with `status: failed`. Evidence: `GET /posts`, `GET /health`, `GET /audit`, and `qa/acceptance-v3.1.0.md`. API only. No src/ or tests/ read. |

**Kind of change:** one blocking posting bug with the behavior we expect and pass/fail tests, plus small findings from the v3.1.0 acceptance pass. How to fix each is DOM's choice. Route and field names are suggestions.

## Context that needs no change
- CR-016 items that could be checked on 3.1.0 without waiting for tonight's scheduled run all passed: `/health` `review_reason`, in-call 503 retries with `attempts`, idempotent replay of `POST /jobs/run` (same `run_id`, `idempotent-replayed: true`), run rows with per-step status, and the new `jobs.daily.last_scheduled` / `missed_slot` fields (present; both null today).
- Outside review still fails with Google free-tier 503 on all tries. That is Google's load, not a DOM bug from this CR. Options for a model or tier change stay with Dvir.
- Dry-run / practice `POST /posts` paths that never contact Buffer still return success shapes. They could not catch this failure.

## 1. Findings, expected behavior and acceptance tests

### A (high): real create against Buffer rejects the images input; posting is failed
- **Seen (live v3.1.0, 2026-10-08 16:14 IDT):**
  - `POST /posts` (idempotency key `x-post1-2026-10-08`) created post **`pst_860913653866`**, `status: failed`, `buffer_post_id: null`, `external_link: null`. Audit row: status_code **502**, `result_summary: POST_FAILED`.
  - Full `error` string from `GET /posts` (this is the whole value the API stores; it ends mid-word with `...` as returned):

    ```
    create: refused (HTTP 200): Variable "$input" got invalid value { images: [{ url: "https://domain-trading-api.onrender.com/media/ac0fe45e8b9792211379a26557db1f2f", altText: "Flat illustration of a small office at night: four friendly robots work at desks, one scanning a screen with a magnifying glass, one in a guard cap checki...
    ```

  - `/health` now shows `posting: failed` with the same `posting_reason` text.
  - `GET /posts` `allowance`: `today_cap: 1`, **`used_today: 0`**, `remaining: 1`. So the failed attempt does **not** appear to count toward today's 1-a-day cap. Please confirm whether that is the intended rule.
  - The post body and one PNG image (1600×900, stored under `/media/...`) were accepted by DOM; the refusal is Buffer's GraphQL validation of the `$input` DOM sent for create.
- **Expected:**
  - **R-A1:** DOM builds the Buffer create-post `images` (and related) input to match Buffer's **current** API schema. Our unverified guess is a field shape or nesting mismatch (for example `images` / `url` / `altText` vs whatever Buffer accepts now). DOM chooses the correct shape from Buffer's docs or a live schema check.
  - **R-A2:** before shipping a posting change, DOM either (a) makes **one real call** against Buffer that proves create accepts the images input (a throwaway or immediately-deleted test is fine if Buffer allows it), **or** (b) adds a mode that checks the outgoing request against Buffer's schema **without publishing**. Dry runs that never contact Buffer are not enough; they already passed while this real create failed.
  - **R-A3:** after a failed post, there is a documented way to **retry or clear** that failed row so a corrected post can go out the same day **without** using up the 1-a-day cap (or with a clear rule if a retry does count). Today it is unclear how to recover `pst_860913653866` and whether a new key would burn the allowance.
  - **R-A4:** DOM states whether a failed create counts toward `allowance.used_today`. Live data today shows `used_today: 0` after this failure.
  - **R-A5:** when posting is healthy again, `/health` `posting` returns to `ok` (or the documented healthy value) after a successful create or after the failed state is cleared by the documented path.
- **Questions for DOM:**
  1. What exact Buffer `$input` field or nesting is wrong (and what is the correct shape)?
  2. Did `pst_860913653866` count toward today's cap? (`used_today` is 0.)
  3. How should Gavriel retry post 1 today after the fix (same post id, clear-then-repost, new key)? Does that retry use the daily cap?
- **Tests:**
  - **T17-1:** a real `POST /posts` with text and one image reaches Buffer without a GraphQL `$input` validation refusal; the post ends `sent` (or the documented success status) with a `buffer_post_id` / link when not dry-run.
  - **T17-2:** a dry-run or schema-check mode that claims "would succeed at Buffer" would have failed on the pre-fix images shape (so the gap that let practice runs pass is closed), **or** DOM documents that only a real Buffer call is the gate and that gate ran before ship.
  - **T17-3:** after a failed post like `pst_860913653866`, the documented retry/clear path works, and the contract states whether that path consumes the daily cap.
  - **T17-4:** `/health` `posting` is healthy after a successful create (or after clear), and no longer stuck on the old Buffer refusal text.

### B (low / info): small findings from `qa/acceptance-v3.1.0.md`

#### N-4 (low): `/health` `review_reason` cut at 120 characters
- **Seen:** `review_reason` ends mid-word: `... Please t` (Google 503 text). Same truncation length as stored (~120 chars).
- **Expected (R-B1):** either store/return enough of the reason to be useful (full short Google message, or a stable code like `UNAVAILABLE` plus a non-truncated snippet), or document the 120-character cap in the contract.
- **Test (T17-5):** when review fails with a long Google reason, `/health` `review_reason` is either complete or matches the documented cap without looking like a bug.

#### N-5 (low): idempotent replay of `POST /jobs/run` still uses a WRITE rate-limit slot
- **Seen:** two `POST /jobs/run {"job":"tick"}` with the **same** key: both 202, same `run_id`, second has `idempotent-replayed: true`. The replay still moved the hourly WRITE allowance (3 → 2 of 4).
- **Expected (R-B2):** a pure idempotent replay does not consume a rate-limit slot (preferred), **or** the contract says that replays count so schedulers know not to retry with the same key under a tight cap.
- **Test (T17-6):** after a successful run, a same-key replay leaves `remaining` WRITE calls unchanged, or the contract states that it decrements.

#### N-6 (low): `jobs.daily.last_scheduled` empty though the 10-08 03:05 run started
- **Seen:** on 3.1.0 after the 10-08 morning checks, `jobs.daily.last_scheduled` is `null` even though the 03:05 IDT run **did start** (early audit rows; no scheduled row was kept because of the mid-run restart explained in CR-016). So a lost pre-3.0.0 run looks the same as "never scheduled".
- **Expected (R-B3):** from 3.0.0 / 3.1.0 onward, a started scheduled run always leaves enough state that `last_scheduled` (or an equivalent) is not null the next morning. Recheck after tonight's 03:05 run is enough if DOM confirms no backfill is planned for 10-08.
- **Test (T17-7):** after tonight's scheduled daily completes (or fails with a row), `last_scheduled` is set for that slot.

#### N-7 (info): manual `tick` can call Google when a review retry is pending
- **Seen:** tick on 3.1.0 has a `reviewRetry` step (08:30 UTC / 11:30 IDT path). A manual `POST /jobs/run {"job":"tick"}` can therefore call Google when a retry is pending. Today's manual tick skipped with `NOTHING_PENDING`.
- **Expected (R-B4):** document that a manual tick may trigger `reviewRetry` / Google, **or** add a flag / option so a manual tick skips review retry unless asked.
- **Test (T17-8):** the contract (or DOM's answer) states the rule; if a flag exists, default and override are clear.

#### Still open (carried; please answer or fix)
- **N-1:** `GET /candidates/daily` still reports `partial: true` after screening finished (screeningResume finalized, then list build). DOM mentioned `POST /candidates/daily/rebuild`; please confirm when `partial` clears without a rebuild, and whether rebuild is required after a recovery run.
- **N-3:** recovery / some runs have `triggered_by` empty (`null`). Please set it (for example `recovery` / `manual` / token name) or document when it is null.
- **N-2 / backups:** `backupExport` skips with `GITHUB_BACKUP_TOKEN is not set`, so backups do not run. **Question for DOM:** what exactly does DOM need set (secret name, scopes, target repo/branch or gist, who creates the token), and is anything else required before backups are on? Gavriel will not invent the secret; DOM should name what to request from Dvir.

## 2. Open questions for DOM
1. Answers to A (correct Buffer images `$input` shape; cap accounting for failed creates; retry/clear path for `pst_860913653866`; `/health` posting recovery).
2. Which of R-A1..R-A5 and R-B1..R-B4 does DOM expect to meet, and does it push back on any, with the reason?
3. Answers on N-1 (`partial`), N-3 (`triggered_by`), and N-2 (what `GITHUB_BACKUP_TOKEN` needs).

<!-- DOM writes below this line -->

## DOM response (2026-10-08)
**Accepted. Release v3.2.0.**
- **A, the cause:** DOM built the `createPost` input from Buffer's guides, but Buffer's GraphQL reference defines it differently.
  - **`assets`:** a **list** of `AssetInput`, each with exactly one of `image` / `link` / `video` / `document`. So an image is `assets: [{image: {url, altText}}]`. DOM sent `assets: {images: [...]}`.
  - **Mode field:** the mode field is **`shareMode`** (`shareNow`).
  - **Thread parts** take `assets` the same way.
- **R-A2 (b):** DOM adds `POST /posts/schema-check` (WRITE).
  - **What it does:** it asks Buffer's GraphQL API for the type definitions (introspection: read-only, publishes nothing) and checks the exact input DOM would send, images and thread included.
  - **The answer:** `{ok, problems[]}`.
  - **The real path:** a real post runs the same check first and refuses with 502 `POST_FAILED` (`step: schema`) before sending anything that doesn't match.
  - **Testing:** DOM can't call Buffer itself (the key lives only on the server and there is no sandbox), so the schema check is the gate; **please run it before the first real post on 3.2.0.**
- **R-A3, R-A4:**
  - **The cap:** a **failed** create does not count toward the cap (`used_today` 0 is right; only `posted`, `unknown` and `removed` count).
  - **Retrying:** retry with a **new** `Idempotency-Key` and the same body. The old key replays the old 502 by design.
  - **The failed row:** `pst_860913653866` stays as a `failed` record (append-only history), and needs nothing done.
- **R-A5:** `/health` `posting` follows the **latest** post, so the first successful post makes it `ok` again.
- **N-4:** `/health` `review_reason` becomes `CODE: text`, for example `UNAVAILABLE: The model is overloaded...`. It is at most 200 characters, cut at a word, and the contract states the limit.
- **N-5:** an idempotent replay no longer uses a rate-limit slot.
- **N-6:**
  - **10-08 is not backfilled:** that run was lost before 3.0.0 existed.
  - **From 3.0.0:** a scheduled run has a row from the moment it is queued, so `last_scheduled` is set after tonight's run (T17-7).
- **N-7:** the contract will say a manual `tick` runs `reviewRetry` too, when a review retry is pending (one Google call). There is no flag; that is the point of the retry.
- **N-1:** see CR-020 C (fixed there).
- **N-3:** `triggered_by` becomes the token's name for a WRITE token, `job-token` for the job token, and `cli` for the CLI. It is never null for new runs.
- **N-2, backups:** off **by Dvir's decision** (7 Oct, and again 8 Oct: "No"), so `backupExport` is expected to say not configured.
  - **What it would need, if Dvir ever reverses that decision:** `GITHUB_BACKUP_TOKEN` (a fine-grained GitHub token with Contents read/write on `DvirBaumel8/domain-trading-data` only) and `GITHUB_BACKUP_REPO=DvirBaumel8/domain-trading-data`, both set on Render.
  - **Nothing to request now.**
