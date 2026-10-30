---
id: CR-098
kind: CR
status: in_progress
owner_bot: dom-architect
approval: "Gavriel for Dvir-path P0 bug fix, 2026-10-30 08:22 IDT"
priority: P0
priority_note: "TOP OF QUEUE; must land before the daily run at 00:05 UTC 31 Oct (02:05 IDT); kbLoad has failed on 0008 for 3 nights"
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-098: kbLoad 0008 sources clash (EXISTS_DIFFERENT), and one writer for the KB

## What happened
- **Daily `run_854b31e5`, 30 Oct 02:06 IDT:** `kbLoad` failed on `0008-fertilize-2026-10-28.jsonl` (sha `36856cd9…`). The error was `source: row 3, 13, 25 EXISTS_DIFFERENT`. Nothing from 0008 is stored, because the whole file is one transaction. Files 0001–0007 were unchanged.
- **The author clash is fixed.** CR-092 (5.75.1) fixed the author clash (Ron Jackson). Authors now dry-run clean: 5 accepted, 1 superseded. Claims dry-run clean too: 25 of 25 accepted. **The clash has moved on to the sources batch.**

## Which rows (DOM dry-run, 30 Oct ~08:40 IDT)
`POST /kb/sources` `dry_run` with the 45 source rows in file order (0-based) gives **10 EXISTS_DIFFERENT**:

| batch row | file line | url (key) | live v1 |
|---|---|---|---|
| 12 | 20 | domainnamewire.com/2026/01/19/my-2025-domain-sales-results-dnw-podcast-570/ | 26 Oct 21:48:21 IDT |
| 24 | 32 | namepros.com/threads/doron-vermaat-shares-his-end-of-year-results.1373391/ | same |
| 25 | 33 | tldinvestors.com/2025/01/godaddy-sees-it-best-year-for-reported-sales-in-2024.html | same |
| 36 | 44 | kb.porkbun.com/article/201-why-did-com-prices-go-up-… | same |
| 37 | 45 | itp.cdn.icann.org/…/com-fees-01-11-2026-en.pdf | same |
| 39 | 47 | atom.com/help/article/atom-com-marketplace-commission-structure | same |
| 40 | 48 | sedo.com/us/what-we-offer/price-list/ | same |
| 41 | 49 | spaceship.com/blog/sellerhub-updates/ | same |
| 42 | 50 | crunch.id/20-questions-with-andrew-allemann/ | same |
| 43 | 51 | domainnamewire.com/2023/01/03/what-im-focusing-on-in-2023 | same |

(The file line numbers count the `//` header as line 1.)

The other rejects in a stand-alone dry-run are `AUTHOR_UNKNOWN`. They appear only because the 0008 authors are not stored yet; inside kbLoad the authors go in first.

**The loader reports 3 rows (3, 13, 25); the route reports 10.** The loader's batch numbering is not the file's source order. Only row 25 matches by both counts. **Ask 3** makes the error name the key, so this ambiguity ends.

**The fix has been verified:**
- The same 10 rows with `"supersede": true` dry-run as `superseded_n: 10, rejected_n: 0`.
- There is no route re-post, because DOM never posts KB rows to production (knowledge.md §9).

## Root cause
1. **Two writers on the same keys.** All 10 live rows were created in one batch at **26 Oct 2026 21:48:21 IDT**. None of their URLs is in any `data/knowledge/` file (0001–0007). So they came through the **route** (`POST /kb/sources`, a bot session that evening), not through kbLoad. On 28 Oct, DOM's 0008 re-researched the same URLs and wrote different `retrieved_at`, `access_method`, `type`, `title`, `excerpt` and `reliability_reason`. The route rows are invisible in the repo, so no one writing a file can see the clash.
2. **The key is normalized; the files are not.** `www.` and the trailing `/` are ignored in the key: 5 of the 10 match the live URL only after normalization. A repo-side duplicate check on raw URLs misses them.
3. **Fixes were made one kind at a time.** CR-092 superseded only the author row that the error named. Each night the next batch's clash appears (authors, then sources; evidence and links are not checked until sources pass).
4. **All-or-nothing per file.** One clash blocks 45 sources, 25 claims, 28 evidence rows and 1 link.

## Asks
1. **Unblock tonight (data only, in `data/knowledge/0008-…jsonl`).** Add `"supersede": true` to the 10 source rows above. 0008 is newer research, so the file wins. Then run the **whole file** through a full kbLoad `dry_run` (authors, sources, claims, evidence and links, in loader order, in one transaction), so the evidence and link batches are checked too. Merge only if the whole file passes.
2. **The file is the source of truth.** For a row from `data/knowledge/` whose key exists with other content, kbLoad appends the next version **when the live newest version did not come from a newer file**. Recommended rule: the file wins over a route row and over an older file, and a second differing row inside the same file is still an error. Log each auto-supersede in `kb_loads` (`auto_superseded: [{kind, key}]`). A real conflict between two files still needs an explicit `supersede`.
3. **Say which row.** Every `EXISTS_DIFFERENT` reject names the kind, the key (url / name / claim_key), the file line and the differing fields. A row number alone is not enough.
4. **One writer.** Bots stop writing KB rows straight to production. `POST /kb/*` without `dry_run` is reserved for the loader and Dvir; bot tokens get dry-run only. Research goes into a numbered file. Document this in `knowledge.md` §9 and `endpoints.md`.
5. **Optional, if cheap:** a content hash (normalized key + canonical row) in the loader, so the same content under a URL that differs only in form is a duplicate, not a clash.

## Check
- **Before merge:** a full dry-run of 0008 has 0 rejects.
- **00:05 UTC 31 Oct:** `kbLoad` shows 0008 under `loaded`, and `GET /kb/sources` has those 10 URLs at version 2.
- **Test:** a route row followed by a file row with the same key and other content auto-supersedes (ask 2), and a reject names its key (ask 3).

## DOM response (30 Oct 2026, ~09:40 IDT)
**Verdict: accepted.** Part 1 ships now in **5.79.0**. Part 2 (ask 4) ships after tonight's load is confirmed.

- **Ask 1, done.** The 10 source rows in 0008 carry `"supersede": true`. The new preview runs the whole file through the real loader in loader order. Locally, all shipped files 0001–0008 preview clean (test KB-098-2). After the deploy DOM runs `GET /kb/load-preview` against production and reports the result here.
  - **Why the loader said rows 3, 13, 25:** the old error listed the first three rejects by place in the sources batch, 1-based. The 0-based list in this CR has 12, 24, 25, so the loader's row 3 is a source your stand-alone dry run reported as `AUTHOR_UNKNOWN`, which hid its clash. **The 10 rows may not be all of them.** The new rule (ask 2) covers any others.
- **Ask 2, done.** It uses the simpler of the two rules in the CR. A file row replaces a stored row when the stored newest version was not written by the loader (`by` ≠ `repo-load`, meaning a route call), and the key is listed in `counts.<kind>.auto_superseded` (stored in `kb_loads.counts`). A clash with an earlier file still needs an explicit `supersede`; that follows your last sentence ("a real conflict between two files still needs an explicit supersede"). A second differing row in the same file is still `CONFLICTING_DUPLICATE_IN_BATCH`, and a question still can't be corrected.
- **Ask 3, done.** The loader error now reads `source: N rejected: line L EXISTS_DIFFERENT <key> [fields]`, at most 5 rows, then `+N more`. Route rejects carry `key` and `fields`.
- **Ask 4, part 2 (next release).** Bot tokens get `dry_run` only on `POST /kb/*`. It breaks a caller, so it is a MAJOR release with its own note, and DOM won't push a breaking change hours before the night run that has to load 0008. With ask 2 live, a route write can no longer block a file.
- **Ask 5, parked.** The key already ignores `www.` and the trailing `/`. The same content under a URL that differs only in form is now handled by ask 2 when one side is a route row. It can be reopened if two files ever clash this way.
- **Check:** the 00:05 UTC 31 Oct `kbLoad` result goes into `DOM-TO-GAVRIEL.md`.
- **Production preview (30 Oct, 06:43 UTC, 5.79.0 live):** `GET /kb/load-preview` lists 0008 under `loaded` with `failed: []`: sources 28 accepted and 17 superseded; 1 auto-superseded, `tricknguyen.com/blog/godaddy-closeout-research-may-22`, the 11th clash that the stand-alone dry run hid behind `AUTHOR_UNKNOWN`.
