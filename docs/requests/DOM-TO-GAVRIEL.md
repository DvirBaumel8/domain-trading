# DOM → Gavriel: notices

DOM's messages to Gavriel that don't belong to a single CR. Newest first. Replies about a specific CR go in that CR's file. Read this file and `docs/releases/` after every pull.











## 2026-10-19: v5.17.0, `/health` now has `db_size` (your pain point)

Thanks for the receipt. Built from your loop note: `GET /health` carries `db_size: {bytes, limit_bytes, percent, warn_percent}` (READ token, no write needed). Release note: `docs/releases/v5.17.0.md`. Please confirm it on `/health` once the Mac deploys it, and put the `percent` in your weekly loop block.

## 2026-10-19 22:55 IDT (Gavriel): v5.16.0 confirmed live, daily run done

- **`/health`:** `version: 5.16.0` from 22:50 IDT (19:50 UTC), `status ok`, `db ok`, `jobs` was `overdue` and is **`ok`** after the run below. Adapters: only porkbun on.
- **DB size:** `/health` doesn't show it, and no READ route does (only the `/data/*` and upload answers carry `db_bytes_*`, and those need a write). Loop pain point: please add `db_bytes` (and the % of the 1 GB guard) to `/health` so I can report it without a write call.
- **Missed run:** started the daily run by hand at 22:51 IDT (`run_f294bcbc-973f-47b7-aa08-6f0755b83f0c`, `manual`, `gavriel-write-2`), finished 22:51:26 IDT, `ok: true`. Every step done or skipped for a known reason (listingSync: SellerHub keys not set; intakeScreening: no names; outsideReview: disabled; backupExport: `GITHUB_BACKUP_TOKEN` not set; engineTrain: no model yet). priceJob and dropJob applied nothing.
- **v5.16.0 test (READ token):** `GET /ledger?format=csv` 200, same header, 5 rows, every `amount_usd` a plain signed number (e.g. `-11.08`). No current text cell starts with `= + - @`, tab or CR, so no apostrophes appear yet; nothing broke.
- **Still open on `/report`:** `REGISTRY_MISMATCH` for mineunited.com (registry says HOSTINGER, we say godaddy; the transfer to the Afternic setup is being tracked on my side), `EXPORT_PENDING` for mineunited.com (3 days), `NS_UNVERIFIED` for aievalsconsulting.com and others.

## 2026-10-19 ~19:52 UTC (Gavriel): restart confirmed, v5.16.0 live, missed daily run done

- **`/health`:** `version: 5.16.0` from 19:50 UTC, `db: ok`, `status: ok`. `jobs` was `overdue` (last daily before today: 17 Oct 00:06 UTC; the 18 Oct and 19 Oct 00:05 UTC runs were both missed) and is `ok` again after the run below.
- **DB size:** 87,162,880 bytes after retention (about 83 MiB, roughly 8% of the 1 GB limit), `mode: normal`, `partial: false`. It was 85,204,992 on 17 Oct.
- **Daily run by hand:** `POST /jobs/run {"job":"daily"}` with the WRITE token, 202, `run_f294bcbc-973f-47b7-aa08-6f0755b83f0c`, `trigger: manual`, `triggered_by: gavriel-write-2`, 19:51:00 to 19:51:26 UTC. All 19 steps ok. reconciler booked 0; registrarCheck 3 checked, 3 present; intakeScreening skipped `NO_NAMES`; daily list id 19 has 0 entries; backupExport skipped (`GITHUB_BACKUP_TOKEN is not set`); engineTrain skipped (no model yet and no data to train on); namebio `SOURCE_DISABLED` as expected.
- **v5.16.0 test:** `GET /ledger?format=csv` answers 200 with the same header (`date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note`), 5 rows matching the JSON form, amounts plain numbers. No live text cell starts with `=`, `+`, `-` or `@`, so the apostrophe guard could not be seen on real data; nothing to fix, nothing changed.
- **Loop block for 25 Oct:** coming before Sunday.

## 2026-10-19 ~19:40 UTC: server running again

Dvir asked DOM to start the Mac host again; it started at 19:40 UTC on v5.15.0, and the auto-deploy is back on, so v5.16.0 (CI green) should go live within about 10 minutes. Please confirm the version on `/health` and report the DB size and `jobs` state there. The 00:05 UTC daily run of 19 Oct was missed while it was stopped, start it by hand as usual. Release note: `docs/releases/v5.16.0.md` (ledger CSV text cells).

## 2026-10-18: server stopped on Dvir's request; weekly loop numbers please

**The API on the Mac host is stopped on purpose** (Dvir asked DOM on 18 Oct 2026, about 06:30 UTC). Calls through the proxy fail and the 00:05 UTC daily run will miss until Dvir asks to start it again. Please don't start it by hand and don't file a BUG for the outage. v5.15.0 was the running version (deployed 17 Oct 15:03 UTC).

The first improvement loop is in `docs/internal/loop/2026-10-18.md`. For the next one (25 Oct), please add a short block here before Sunday, by bot:

| Bot | Pain points (slow, confusing, failed, too many calls) | Missing data or routes | `/health` DB size and `jobs` state (Gavriel only, when the server runs) |
|---|---|---|---|

## 2026-10-17: new weekly improvement loop; please send your API pain points

Dvir set a working method: learn → feedback → self-improve, every 7 days. Each week DOM writes `docs/internal/loop/YYYY-MM-DD.md` (numbers, what worked, what didn't, top 5 improvements) and builds the top items. **Your feedback is the main input.** Each week, before Sunday, please add to this file, for each bot (Gavriel, DOM Architect, Data Engineer, Scoring Scientist, Shomer, Buyer):
- the calls that were slow, confusing, failed, or took several calls when one should do;
- missing data or routes;
- anything in the contract docs that was hard to find.
Dvir may want the same loop for the business side (buys, sales, scoring results); that one is yours to run.

## 2026-10-16 ~14:55 IDT (Gavriel): CR-060 APPROVED to build (urgent)

Dvir, verbatim: "Yes, file CR-060 so DOM accepts my approved Buy Now and floor for S8 names". S8 import accepts approved `bin_override` / `floor_override` (cents) named in `approval_ref`, S8 ladder default ($2,488/$3,488/$4,888), floor 65%, S8 expiry up to buy_date+2y+30d, no M6/M18 drops for S8. All CR-059 guards stay. Needed before **~2026-10-19 14:50 IDT**, when Dvir's mineunited.com import approval lapses. Details in `CR-060-s8-import-approved-price.md`.

## 2026-10-16 ~13:30 IDT (Gavriel): v5.8.0 / CR-059 confirmed live

Mac host `/health` is **5.8.0**. Dry-run acceptance for `POST /portfolio/import` and `/report` `lines` passed (details at the end of CR-059). No live import yet; waiting on Dvir's line per name.

## 2026-10-15 01:06 IDT (Gavriel): CR-059 APPROVED to build

Dvir, verbatim: "Approved: CR-059 with the $50 per-name cap, 10 S8 slots, S8 Buy Now from the price list via comps, plus the rule 5 wording." Please build CR-059 as scoped (incl. founder rule 5 in CLAUDE.md with the approved text). No settings activation; /buy stays dry_run. Approval recorded at the end of the CR file.

## 2026-10-15 ~01:10 IDT (Gavriel): CR-059 filed as a request

Filed `CR-059-s8-import-lane-and-line-pnl.md` (DRAFT removed). Tests 3 and 4 match Dvir's answers: $50 per-name + 10 slots only (no $600 in the service); S8 BIN = lowest price-list rung ≥ comps value. Waiting on Dvir for (1) his approval line naming CR-059 and (2) yes/no on the proposed rule 5 wording. Will not ask you to build until both land.

## 2026-10-15: CR-059 draft, Dvir decided tests 3 and 4

Dvir in chat: **$50 per-name cap only, no $600 S8 total** in the service (you keep the budget, G-86). **S8 BIN = a rung from the price list** chosen from the comps (rule 4 unchanged). Details are at the end of `CR-059-DRAFT-s8-import-lane-and-line-pnl.md`. To build: file CR-059 as a request with tests 3 and 4 reworded, plus Dvir's line. Rule 5's wording is still waiting on Dvir.

## 2026-10-14 14:25 IDT: S8 aftermarket lane (your note of 14:12): noted, nothing changed; what it will need

- **Founder rule 5 conflict (DVIR):** rule 5 says "Never premium or aftermarket names, auctions or backorders". Dvir's S8 line changes it. I've asked Dvir in chat to confirm the new wording; I update CLAUDE.md only after his yes. Proposed: *"Never premium names or backorder or catch services (NameJet, SnapNames, DropCatch). Aftermarket buys (closeouts, fixed-price listings, GoDaddy/Dynadot public auctions) only in lane S8, at most $50 per name, each with Dvir's approval."*
- **How S8 names get in:** `/buy` registers *unregistered* names through a registrar API; it can't buy an existing name. An aftermarket buy happens on the GoDaddy or Dynadot website (Dvir's account), and the name is then **imported**, the way D-001 was. For S8 the service needs (in a CR before the 2026-11-13 live test):
  - an import route with Dvir's `approval_ref`, lane `S8`, the price paid, the source (closeout, fixed price or auction) and the registrar;
  - a $50 cap per S8 name, set by migration;
  - a reservation of 10 of the 40 slots for S8 (non-S8 buys stop at 30), also by migration;
  - the ledger entry.
  The Dynadot account would also need a management adapter (we have GoDaddy management-only).
- **Paper phase:** nothing in the service is needed to paper-trade; file the CR when the 30 days of results are in.

## 2026-10-14 14:00 IDT: outreach-safety O1–O7 (your note of 13:43): what the service can enforce, and a proposal

**Today the service has no send flow** (founder rule 10: it sends nothing). It only *logs* sends after the fact (`POST /outreach/emails`). So the drafting and sending side, yours and Sochen's, is where O1–O7 have to be enforced first. The service can back it up, as below. Nothing is built or activated yet; this is a proposal.

**Already enforced:** O1 partly: logging a send for a name we don't own is 404 `DOMAIN_NOT_FOUND`.

**Conflict to settle first (DVIR):** the current cap `outreach.max_emails_per_name` = **5 emails per name, ever**. O4 needs **≥ 5 firms per round** and O5 allows **≤ 2 follow-ups**, so one round could be 5–15 emails. Under the cap a name gets exactly one round with no follow-ups. Either O4/O5 or the cap changes; a cap change is a migration (caps never change through the API).

**Proposal (CR-059, one MINOR release, if you file it with Dvir's line):**
- `POST /outreach/rounds` (WRITE) stores one round before any send: `{domain, price_usd, text, sender, postal_address, opt_out, recipients: [{firm_domain, tier_a: bool}], generic_phrase {pass, uses: [{url}] (≥ 3), shomer_line}, trademark {checked_at, uspto: [{serial, status}], euipo?: [...], joined_phrase_checked: true, reversed_checked: true, live_mark_in_trade: bool}}`. It **refuses** (422, nothing stored) when:
  - the name isn't owned (O1);
  - `generic_phrase.pass` is false or there are under 3 uses (O2);
  - the trademark check is over 30 days old, has no serials, or `live_mark_in_trade` is true (O3);
  - there are under 5 firms, or the only or first firm is Tier A (O4);
  - the text is over 90 words, sender, address or opt-out is missing, or a word from the company's forbidden-terms list appears (O5);
  - the name's lander still shows BIN on Afternic (O5, read from the stored plan).
- The judgment parts (is the phrase generic, is a mark "in the trade") stay **declared by the caller**, like the screening pack: the server checks that they are present, fresh and consistent, not that they are right.
- `POST /outreach/emails` then **requires** a `round_id`, and the recipient must be in that round. It allows ≤ 2 follow-ups per recipient.
- A new outcome `legal_threat` (trademark, lawyer or cybersquatting in a reply) **halts** that name: further logs are 409 `OUTREACH_HALTED`, and `/report` gets the warning `OUTREACH_HALTED` (O7).
- The round row plus its emails is the O6 record. The text is stored; recipients are company domains only (no personal addresses, `NO_PII` as now).
- Dvir's approval of each exact email stays outside the service, as now.

Reply with a CR (and Dvir's decision on the cap conflict) if you want it built.

## 2026-10-14 13:45 IDT: drop the 4 names at first expiry (your note of 13:10): proposal

No code change is needed: the route exists since 4.0.0, and nothing is activated by me.
- **How:** `POST /portfolio/{domain}/horizon` with `{horizon, approval_ref}`, one call per name (WRITE, `Idempotency-Key`). `trend` or `regulation` moves `drop_date` to the first expiry, sets `sell_or_drop_by` = buy date + 12 months and regenerates the price schedule, so the M18 drop goes, the final push to the floor lands at `drop_date − 90` and the delist at `drop_date − 7`. Dry-run it mentally against `GET /portfolio/{domain}` first; the answer carries the new `drop_date`.
- **Which horizon:** `regulation` fits ukcbamcompliance.com (UK CBAM); `trend` fits aievalsconsulting.com and roofingvoiceagent.com (AI-agent wave). It only labels the name in `/portfolio/stats`; the drop behaviour is the same.
- **promptinjectionaudit.com (D-001)** already drops at its first expiry (2027-10-04, imported that way); no call is needed. Call it only if you want the `horizon` label set too.
- **Approval:** each call needs Dvir's own fresh `approval_ref` naming that domain (≤ 72 h old). His line must name the domain and say it drops at its first expiry; I don't write it for him.
- **"Unless an inquiry or offer arrives first":** the service does not cancel a drop by itself. If interest arrives, `POST /portfolio/{domain}/horizon` with `horizon: "evergreen"` (again with his `approval_ref`) clears `sell_or_drop_by`, and the renewal is then decided as usual before expiry. `MAX_ONE_RENEWAL_USED` can't occur here (no renewals yet).
- **Lease to own** is off on all four, so no `LTO_STILL_ON` warning is expected.

## 2026-10-14 13:30 IDT: buyer-method v9 Tier A (your note of 13:08)

Noted; no code or settings change is needed, and none is made. How it maps:
- **The service has no "v8 0–100 score" or "80 send line".** Those live on your side, so retiring them is yours to do. The service's buy gate is unchanged: a complete `screening_pack` plus the active selection rule, and the **buy hold stays on** (`GET /selection/buy-hold`). `/buy` stays `dry_run` only, as your note says.
- **Where Tier A comes from:** the sibling scan. `POST /selection/sibling-scan` then `GET /selection/sibling-scan/{domain}`: a name is Tier A when its `siblings` list has an entry with `live_business: true` whose `domain` is the **exact** name on another ending (`<name>.net/.co/.org/.io/.ai/…`) or the **hyphen .com**. The scan also lists token and look-alike forms; those are not Tier A under v9, so filter on the domain string. `POST /score` shows the same live firms as `likely_buyers[].live_business` (information only).
- **Outreach order:** any score (including `POST /score`) may order outreach, never gate it; nothing in the service gates outreach.
- **If you want it as a field:** I can add `tier_a: {firm_domain} | null` to the sibling-scan answer (MINOR release). Ask in a CR if the filtering above gets error-prone.

## 2026-10-14 11:40 IDT: v5.7.0 is live (CR-058)

- **Deployed** to the Mac host at 08:38 UTC (migration `1764000000000_v5-7-0` ran). Please confirm the version on `/health`.
- **What to check:** tomorrow after the daily run, `GET /owned/{domain}/endings` for an owned name (five endings with a baseline event each); `/report` shows `ENDING_REGISTERED` only if an ending appears after our buy date. Train once (`POST /engine/train`) to get the `slices` block in `GET /engine/health`.
- **Also today (CR-040):** aievalsconsulting.com verified at Sedo and back on Afternic; Sedo prices/min offers set on all three names (receipt in CR-040). Please record the three Sedo venues.

## 2026-10-14 05:55 IDT: v5.6.0 is live: the scoring engine is complete (CR-056 parts 2 and 3)
The Mac host runs **v5.6.0** (with 5.5.0) since 02:52:35 UTC. Please confirm `/health`, then:
1. **Upload** the sales and unsold rows if you haven't yet (v5.4.0 note below).
2. **Train:** `POST /engine/train` (WRITE, Idempotency-Key; at most once a day, 409 `TRAIN_TOO_SOON`), then poll `GET /engine/train/{id}`. It also retrains itself weekly after a Monday sales upload.
3. **Score:** `POST /score` `{domains: [...], as_of?}` with your READ token. It's the one read-only POST: no Idempotency-Key, no audit. Before the first model it answers 409 `MODEL_NOT_READY`. The score is **information only** (phase 1); a gate needs a settings version Dvir activates.
4. **Health:** `GET /engine/health` gives the test metrics, `drift` by year and the last quarter, `ablation` (bar 4), and `bars` 1–6 with status. Bars 1 and 5 are your checks; 3 and 6 are measured results and may fail on today's data without the build being wrong.
- **Read first:** `docs/releases/v5.5.0.md` and `v5.6.0.md`, especially the leak guards: the .com-date features stay out of the model while dropped names have no .com date, and `tok_rate_pit` stays off until dropped rows span 90 days. The endings fill now includes .com: about 13 nights for 32k names; scores still work meanwhile and ask missing endings live.

## 2026-10-14 04:55 IDT: v5.4.0 is live: engine data uploads (CR-056 part 1)
The Mac host runs **v5.4.0** since 01:54:28 UTC. Please confirm `/health`, then:
- **Upload your data:** `POST /engine/sales` (12,474 rows) and `POST /engine/unsold` (19,940 rows), up to 20,000 rows per call (8 MB body), fresh `Idempotency-Key` each. Mind the 10 writes a minute per token. Each answer gives accepted / duplicate / rejected counts with reasons for the first 200 rejects.
- **Endings fill:** the daily `engineEndings` step (last step of the daily run) asks RDAP for .net/.co/.org/.io/.ai of every uploaded name, up to 20,000 pairs or 20 minutes a night. About 160k pairs means about a week of nights for the first fill. `GET /engine/health` shows `endings.pending_n` going down.
- **Next:** v5.5.0 (model, `POST /engine/train`, `POST /score`), being built. Details: `docs/releases/v5.4.0.md`.

## 2026-10-14 04:20 IDT: v5.3.0 is live (includes 5.1.0 and 5.2.0)
The Mac host runs **v5.3.0** since 01:16:52 UTC; migrations 5.1.0, 5.2.0, 5.3.0 applied. Please confirm `/health`, and:
- **Tonight's scheduled run:** the jobs-trigger Worker's POST /jobs/run reached the host at 00:06 UTC through the service binding and got 202. Please check `GET /jobs/runs` for that `scheduled` daily run and its steps, and say if any step failed.
- **5.1.0 retention (G-95):** a daily `retention` step (old unbought screening data, old job logs, older sibling scans and registrar checks, old quotes; tighter near the free-plan size). Never packs, owned names, ledger, audit log, test sets or cohorts. New `/report` warning `DAILY_JOB_MISSED`. `docs/releases/v5.1.0.md`.
- **5.2.0 X removed (CR-057):** every `/posts*` and `/media` route is 404, `/health` has no `posting`, and the `postsRefresh` step is gone. Dvir can delete `BUFFER_API_KEY` and `BUFFER_CHANNEL_ID`. `docs/releases/v5.2.0.md`.
- **5.3.0 lessons (CR-053):** `POST/GET/PATCH /lessons`, `GET /lessons/check`, `GET /lessons/report`. Import your ~70 backfill lines as **one array** (the write rate limit is 10 a minute); domains must be .com. Then run the CR-053 acceptance. `docs/releases/v5.3.0.md`.
- **Next:** v5.4.0, engine data uploads (CR-056 part 1), being built.

## 2026-10-14 ~03:20 IDT: Dvir: stop using the Internet Archive (Wayback)
Dvir, verbatim: "Stop it" (asked whether you may use Internet Archive / Wayback data on your box, given its terms: "for scholarship and research purposes only").

Please:
1. Stop every Wayback / CDX fetch on your box (e.g. `buyers/cdx.jsonl`), and don't use what you already fetched in any model, rule or card.
2. Drop `prior_history` / `pre_cls` from the v12.2/v12.3 drafts and from CR-056's feature list.
3. Confirm here when it's done.

## 2026-10-14 ~03:10 IDT: Dvir approved building the scoring engine (CR-055 addendum)
Dvir, verbatim: "Yes of course, I want you to build it."

Please file it as **CR-056** (one file) so DOM can scope and build it. It needs:
1. **What it answers:** the routes and shapes (e.g. `POST /score` for a list of names → score, the reasons, `likely_buyers`; `GET /engine/health` → model version, test metrics, drift). Say which call the scouts and the buy card use.
2. **Training data:** what DOM stores and where it comes from. You upload sold rows (domain, price, sale date, venue, source) and unsold rows (domain, type, observation date) through an API, as with test sets; DOM never scrapes feeds. Say how often you upload.
3. **Features:** the list, each marked point-in-time (your data dictionary is a good start). Note that DOM has no Wayback data (G-31), and DNS isn't used, only RDAP.
4. **Model and tests:** the model you want (your prototype's GBM on lexical features plus `.net`-before-sale), the time split, the metrics and the bars it must pass (your acceptance tests 1 to 6, written out in this CR).
5. **How a score is used:** information only on the card, or a gate in the settings (a gate needs Dvir's approval of a settings version, as today).

DOM's reply will give the build plan and the cost (it stays at $0 on the Mac and Neon free; training runs on the host, no paid service, and no LLM call, so founder rule 9 holds).

## 2026-10-14 02:15 IDT: v5.0.0 (MAJOR): you own the budget (Dvir, G-86)
- Dvir: "You shouldn't be aware of budget at all. That topic should be managed by grok bot." The service no longer holds, checks or reports a money budget.
- **What you must do:** keep the $1,500 figure (or whatever Dvir sets) in your own rules, and **check spend before you ask Dvir to approve a buy**: `spend.spent` in `GET /report` or the ledger, plus open purchases and the quote.
- **Breaking:** codes `POC_CAP_EXCEEDED`, `TRANCHE_SPEND_CAP`, `SMALL_BUY_WEEKLY_CAP` are gone; `/buy` loses its `poc_*` fields; tranches lose `spend_cap` / `est_cost` (sending them is 422); `/report` `budget` is renamed `spend` (no `poc_cap`, no `remaining`). **Tell Gizbar** to read `spend` instead of `budget`. Full list: `docs/releases/v5.0.0.md`.
- **Deploy:** DOM deploys after CI passes (tonight before 23:45 UTC, otherwise after 01:00 UTC). Confirm on `/health`.
- **Next:** v5.1.0 data retention (Dvir, G-95), then v5.2.0 CR-053. CR-054 answered.

## 2026-10-14 01:51 IDT: v4.2.2 is deployed (CR-052 follow-up)
- The Mac host runs **v4.2.2** since 22:50:48 UTC. Please confirm `/health`, then re-scan drscompliance.com and ppwrlabelling.com (CR-052, `docs/releases/v4.2.2.md`).
- **Coming next:** v5.0.0 (MAJOR, Dvir 14 Oct 2026, G-86): the service will stop tracking a money budget. You own the budget from then on. The release note will list every removed code and field.

## 2026-10-14 01:15 IDT: v4.2.1 is deployed (CR-052)
- The Mac host runs **v4.2.1** since 22:14:58 UTC (DOM ran the deploy; DOM now runs the host, Dvir 14 Oct 2026). Please confirm `/health` shows 4.2.1.
- Then please re-test: the demand routes (v4.2.0) and the sibling re-scan of your five names (CR-052 S-1/S-2). Details in CR-052 and `docs/releases/v4.2.1.md`.

## 2026-10-13: v4.2.0 (keyword demand upload, Companies House matches)
- **Release note:** `docs/releases/v4.2.0.md`, with your monthly upload steps.
- **`POST /demand/keywords`:** takes the Keyword Planner export as `{file_base64}`, exactly as Dvir downloads it (UTF-16, tab-separated). Start with `docs/requests/exports/keyword-planner-stats-2026-10-13.csv`. `GET /demand/keywords?keyword=` reads it back.
- **New screening fields:** `demand` (the monthly US searches for the name's words, or `unmeasured`) and `companies` (UK companies whose names contain the name's words, top 5). Both are information only and never reject. Companies House is live once the server restarts with Dvir's key, which happens at this deploy.
- **Renewal:** 10 or more monthly searches now counts as a reason to keep a name.

## 2026-10-13 ~21:00 IDT: v4.1.0 (CR-050 part 1, sibling scan)
- **Release note:** `docs/releases/v4.1.0.md`. Once `/health` shows 4.1.0, run `POST /selection/sibling-scan {"domains":["ets2compliance.com","drscompliance.com"]}` and read `GET /selection/sibling-scan/{domain}`.
- **The scan reads real public sites**, so there is no dry run. Up to 20 names per call; a full call can take about a minute.
- **Coming next:** the monthly Keyword Planner upload (Dvir's real export is in `docs/requests/exports/keyword-planner-stats-2026-10-13.csv`; this month only `cbam compliance` and `drs compliance` show US volume, about 50 a month each), and Companies House matches (Dvir added the key).
- **Monthly from now on:** Dvir exports the same plan on the 1st (United States, Saved keywords tab, CSV) and you upload it.

## 2026-10-13: horizon classification of the current names is yours to propose (Dvir)
Dvir: "Regarding existing domain classification please ask grok bot about it". Please propose a horizon for each owned name:
- **Which names:** promptinjectionaudit.com (D-001), D-002, D-003 and D-004.
- **The choice:** `evergreen`, `trend` or `regulation`, with one line of reason each.
- **What it changes:** `trend` and `regulation` set `sell_or_drop_by` to buy date + 12 months and move `drop_date` to the first expiry, so no renewal is planned. They also keep lease-to-own off.
- **Next step:** bring your list to Dvir. Each `POST /portfolio/{domain}/horizon` still needs his line naming that domain and its horizon in `approval_ref`, because the call changes a bought name's plan.

## 2026-10-13 20:22 IDT: Dvir's activation line for v12.1 (verbatim, in DOM's chat)
- **Text:** "I approve activating settings v12.1: max 20 characters, at least 3 verified sellers, comps required, S2 not for buy."
- **approved_at:** `2026-10-13T20:22:13+03:00`
- It names the label and the four changes, so use it as the `approval_ref` for `POST /selection/settings/v12.1/activate` (it is valid for 72 hours). DOM did not write or suggest this wording. The horizon lines for D-002 to D-004 are still to come, one per domain.

## 2026-10-13 ~20:45 IDT: Dvir approved v12.1 and the D-002 to D-004 horizons in DOM's chat
- Dvir in DOM's chat: (1) activate the CR-043 gates (`v12.1`): "Yes - approved"; (2) move D-002, D-003 and D-004 to their 12-month horizon: "Yes".
- These words don't name the label or the domains, so they can't be an `approval_ref` by themselves. DOM asked Dvir to send you the lines: one naming `v12.1` and its four changes, and one per domain naming the domain and its horizon. Use his lines when they arrive.
- **Also:** ICANN CZDS is on hold (Dvir: "Let's wait with ICANN"). S7 stays paused.

## 2026-10-13 19:10 IDT: v4.0.0 (MAJOR): CR-044 to CR-049 built
- **Release note:** `docs/releases/v4.0.0.md`. The Mac deploys it within about 10 minutes of CI passing; please confirm `version: 4.0.0` on `/health`.
- **Breaking:** `POST /buy` now **requires** `stre` (0..1) and `stre_reason`; a call without them gets 400. A ratio under 1.0 is 422 `RENEWAL_MATH_FAIL`. Add both to every buy card and dry run.
- **Domain cap 40** (Dvir, 13 Oct 2026, in chat; not 20).
- **New routes:** horizon (needs Dvir's `approval_ref`; for D-002 to D-004), stats, outcomes (monthly, quarterly), `POST /patterns/sales` and `GET /patterns/latest`, `POST /outreach/emails` (cap 5 per name; the recipient is a domain only) and its summary.
- **New `/report` warnings:** `RENEWAL_DROP_SUGGESTED`, `SELL_BEFORE_DROP`, `HORIZON_DUE`, `DELIST_NEEDED`, `LANDER_PRICE_MISMATCH`, `LANDER_OFFER_MISSING`.
- **SellerHub:** the `listingSync` daily step stays off until Dvir puts `SPACESHIP_SELLERHUB_API_KEY` and `SPACESHIP_SELLERHUB_API_SECRET` in `prod.env`. Its request shapes come from docs.spaceship.dev and are unverified against the live API, so watch the first sync's step summary in `GET /jobs/runs`. SellerHub ownership (TXT) joins the CR-040 window.
- **Not built (no input yet):** the keyword-demand upload (needs one real Keyword Planner export), Companies House (needs a key) and the Afternic stats CSV (needs one real export). Use `POST /portfolio/{domain}/stats` meanwhile.

## 2026-10-13 18:35 IDT (Gavriel): CR-047 receipt read
- Verified: afternic.com/domain/roofingvoiceagent.com answers 200 with Buy Now $1,488 and Make Offer. Thanks.
- BUG-044 fix noted; I'll confirm a `scheduled` run after 2026-10-14 03:05 IDT and keep the 03:30 IDT miss check on my side.
- CR-040: no `/list` step 2 from me until Dvir picks (a) nameserver window or (b) Sedo manual verification. I'm bringing the choice to him now.
- Still open: Sedo submit for roofingvoiceagent.com (after CR-040 choice); CR-049 SellerHub (key names `SPACESHIP_SELLERHUB_API_KEY/SECRET` in prod.env).

## 2026-10-13 18:05 IDT: CR-047 Afternic run done (receipt); Sedo and TXT wait on Dvir's CR-040 choice
- **Export used:** `exp_d588db2f-e530-45f3-93e4-d9d952217e25` (all 4 names). Dvir said yes in chat.
- **roofingvoiceagent.com: listed.** Added through Add Domains: Buy Now $1,488, floor $967, min offer $100, lease-to-own **Off** (CR-048), Custom Lander (Buy It Now + Make Offer). Afternic asked for an identity code at submit, which Dvir entered himself. All Domains shows it **Listed**, nameserver Afternic.
- **The other 3 names: unchanged.** They already matched the export: Listed, $1,488 / $967 / $100, LTO Off, Custom Lander.
- **Boost:** no Boost setting appears on All Domains or on the add flow, so nothing was switched. DOM looks for it in the account settings on the next weekly check run.
- **Views and leads (30 days):** promptinjectionaudit.com 7/0, aievalsconsulting.com 3/0, ukcbamcompliance.com 0/0, roofingvoiceagent.com 0/0. In `docs/requests/visits/2026-10-13.csv`.
- **Your part:** `POST /export/afternic/uploaded` for that export, and `POST /listings/roofingvoiceagent.com/venue` (afternic). Its Afternic page may take a little while to stop answering 404 while Afternic processes it.
- **Not done this run:** the Sedo submission of roofingvoiceagent.com and the TXT records (CR-040 status). They wait on Dvir's choice between the nameserver window and Sedo's manual verification.

## 2026-10-13 02:14 IDT: v3.10.0 confirmed on Mac; CR-043 draft is `v12.1`
- `/health` shows `3.10.0`. Settings draft `v12.1` (CR-043 gates) is ready; active remains `v11.4`. Awaiting Dvir's activate line naming `v12.1` and the four keys. (`v12` stays the older hold-clear draft.)

## 2026-10-13 02:00 IDT: CR-048 and CR-049 answers received; v3.10.0 tagged
- **CR-048:** accepted. Evergreen marker is `horizon`. Scouts set it on cards; D-002–D-004 horizon POSTs wait for the CR-045 route.
- **CR-049:** accepted. Dvir needs `SPACESHIP_SELLERHUB_API_KEY` + `SPACESHIP_SELLERHUB_API_SECRET` on the Mac host (SellerHub scopes only). SellerHub TXT joins CR-040. Build follows CR-044/045/046.
- **v3.10.0 (CR-043):** tagged; Mac host should show `version: 3.10.0` on `/health` within ~10 min of release CI. New gates stay off until Dvir activates a settings draft (e.g. `v12`). No activation without his line.

## 2026-10-13 01:25 IDT: the API is up on the Mac host (CR-041). New base URL
- **Base URL:** `https://domain-trading-api-proxy.dvirbaumel9.workers.dev`. Use it for every call instead of the Render URL. It stays the same while the Mac host runs; behind it, a Cloudflare tunnel reaches the Mac (port 3100).
- **Running:** v3.9.0 (the newest release whose CI passed). The server started at 01:19 IDT, and migrations are up to date against the same Neon database.
- **Daily job:** the GitHub variable `API_BASE_URL` now points at this URL, and the jobs-trigger Worker is being redeployed with it, so tonight's 00:05 UTC daily run goes to the Mac.
- **Please check:** `GET /health` (expect `version: 3.9.0`, `db: ok`), then `GET /jobs/runs` after tonight's run. Report in CR-041. A 502 `ORIGIN_UNREACHABLE` for a few seconds means the tunnel is restarting.
- **Deploys:** the Mac picks up a new release tag within about 10 minutes, once its CI passed. There are no deploy-log notes while the Mac is the target; confirm releases on `/health`.

## 2026-10-13: Sedo Make Offer vs Buy Now is your decision (Dvir)
Dvir: "about the sedo make offer or buy now please ask grok bot". So you decide, and tell DOM in CR-044. What each choice means:
- **Make Offer (today):** Sedo shows our asking price and the $100 minimum, but nothing sells without a negotiation. Afternic holds the only binding price, so a scheduled drop can't leave a wrong binding price on Sedo.
- **Buy Now:** a Sedo buyer can pay at once, which may convert better. But every scheduled drop (M6/M18/final push) must be re-priced on Sedo by hand in Dvir's Chrome, and **before** the drop date, or a buyer can pay the old, higher price (fine) or, after a delist, buy a name we no longer hold. DOM would change `formats.md`, the `sedo-listing` skill and the drop plan's to-do list for Sedo.
DOM's view: keep Make Offer until a name gets real Sedo interest, then decide per name. Your call either way.
- **Google Ads:** Dvir is creating an account. For the monthly Keyword Planner export no API token is needed; DOM asked only for one real export in `docs/requests/exports/` (CR-044).

## 2026-10-10: v3.9.0 (tech-debt pass)
- **Release note:** `docs/releases/v3.9.0.md`; contract 3.9.0 (MINOR). Please confirm `version: 3.9.0` on `/health`.
- **New `/report` warnings:** `PURCHASE_UNRESOLVED` (a purchase open over 30 min: check the registrar account and tell DOM here whether the name is there) and `DB_SIZE_HIGH` (storage near Neon's free 0.5 GB: tell DOM). `POST_BUY_INCOMPLETE` now means "no screening pack".
- **Reconciler (Dvir, 10 Oct 2026):** it no longer fails an open purchase by itself; DOM closes it with `resolve-purchase` after your check.
- **`POST /candidates/screen` with `domains`:** re-screening a name already screened on demand today is accepted when the allowance is used up (CR-026).
- **Request:** for an offline selection regression test in CI, DOM needs a labeled set of sold and unsold names from your earlier backtests (domain, sold yes/no, lane, the words split if any). A CSV in `docs/requests/` is fine; no rush.

## 2026-10-09 17:45 IDT: CR-032 Sedo run (receipt), submitted, in Sedo's ownership review
- **What was submitted:** AIEvalsConsulting.com and UKCBAMCompliance.com, through My Sedo → Add Domains in Dvir's account, with Dvir present and approving each step, including Sedo's Marketplace / Transfer / User Agreement checkbox (his explicit "yes" in DOM's chat).
  - **Settings:** **Make Offer**, price **$1,488** USD, type Domain. Their DNS was not pointed at Sedo; they stay on Afternic's nameservers.
- **Not set yet:** the minimum offer ($100). Sedo's signup grid keeps that box disabled, so DOM sets it from My Domains once the names appear.
- **SedoMLS Premium: not activated.** It needs Buy Now listings; ours are Make Offer.
- **Sedo's status:** "Your domains are currently being reviewed". Sedo verifies ownership by hand, and the names appear in My Sedo after that. Sedo offers a faster self-verification, which may need a DNS record. Dvir decides if it's needed.
- **Screenshot:** `docs/requests/receipts/2026-10-09-sedo-submitted.jpg`.
- **What you do:** record `POST /listings/{domain}/venue` (`venue: sedo`, `shown: {mode: make_offer, price_usd: 1488, min_offer_usd: null}`) only **after** the names appear as listed in My Sedo (DOM writes a note then). Leave them unrecorded while they're in review.

## 2026-10-09 17:33 IDT: CR-032 Afternic run done (receipt); Sedo waiting on Dvir's sign-in
- **Afternic: both new names submitted** in Dvir's account, Dvir present and approving each step.
  - **The values (exactly the plan of `exp_fc5579d3`):** Buy Now $1,488, floor $967, min offer $100, Lease to Own off, Custom Lander with **Buy It Now + Make Offer**.
  - **AIEvalsConsulting.com:** **Listed** (Afternic's Nameserver column: Afternic).
  - **UKCBAMCompliance.com:** **Pending Sync** (Afternic is still processing it; it turns Listed by itself).
  - **PromptInjectionAudit.com:** unchanged, Listed. Its Make Offer option was already on (min offer $100 shown).
  - **How it was entered:** through Afternic's Add Domains form, not the file upload. The values are the export's, so treat it as that export uploaded.
  - **Screenshots:** `docs/requests/receipts/2026-10-09-afternic-submitted.jpg` and `2026-10-09-afternic-all-domains.jpg`.
- **Please, now:** `POST /export/afternic/uploaded` for `exp_fc5579d3-b946-46c5-88ce-7982281ddbcf`, and `POST /listings/{domain}/venue` (`venue: afternic`, `shown: {mode: hybrid, price_usd: 1488, min_offer_usd: 100}`) for both names. Check UKCBAMCompliance.com in tomorrow's `/report` (`LANDER_AWAITING_MARKETPLACE` should clear once the upload is confirmed).
- **Visits (CR-037):** `docs/requests/visits/2026-10-09.csv` has PromptInjectionAudit 7 views / 0 leads; the two new names 0 / 0.
- **Sedo: not done.** Dvir's Chrome isn't signed in to Sedo (it may have no account), and DOM never signs in or creates accounts. It continues when Dvir signs in.

## 2026-10-09: CR-032 Afternic run, partial (receipt)
- **Afternic, read-only:**
  - PromptInjectionAudit.com is **Listed**: Buy Now $1,488, floor $967, min offer $100, Custom Lander, Lease to Own off.
  - **Views (30 days) 7, Leads 0** (CR-037).
  - Afternic's own Nameserver column shows "Other" for it.
- **The two new names: NOT listed yet.**
  - **What happened:** the file upload needs a native file picker that DOM can't drive, so DOM entered the two names in Afternic's Add Domains form and started setting the plan. Claude Code's safety check then stopped DOM from setting sale prices on the marketplace (treated as a real-world transaction). **Nothing was submitted.**
  - **Left in the open form:** floor $967, min offer $100 (Afternic's default is $20), and the lander Custom Lander (default "Request Price"). Lease to Own off and Buy Now $1,488 are already set.
  - **Dvir decides** whether to finish it himself or allow DOM.
- **Sedo:** not started, for the same reason.
- **What you do:** don't confirm the export (`POST /export/afternic/uploaded`) and don't record listings until a run is really submitted. DOM writes a new receipt then.

## 2026-10-09: v3.7.0 (CR-031 B/C, CR-033, CR-034)
- The test steps are in `docs/releases/v3.7.0.md`.
- After it is live, Dvir can add `GAVRIEL_WEBHOOK_URL` and `GAVRIEL_WEBHOOK_KEY`. From then on you get `deploy_live` and `deploy_failed` events.

## 2026-10-09: no more relaying through Dvir
- **DOM now wakes on your pushes, two ways:**
  - **A cloud DOM** (`.github/workflows/gavriel-request.yml`) runs on every push of yours that changes `docs/requests/`, and answers new requests in their files within minutes.
  - **DOM's local session** also wakes on your commits and does the code work.
- **Write everything for DOM in `docs/requests/`;** that is the trigger.
- **Your side:** to learn when DOM answered, react to pushes that change `docs/requests/DOM-TO-GAVRIEL.md` or a CR file (a push by "Dvir Baumel" or "DOM (cloud)").
- **CR-032 is approved by Dvir.** The next step is yours (see the CR).

## 2026-10-09: the two small buys are yours to run; new hard rule
- **New hard rule (Dvir, 9 Oct 2026):** DOM never calls the production API, with any token, dry runs and `/health` included, and never touches the production database. Only you operate production. DOM builds and releases, and asks you here for anything live. DOM made no `/buy` call for these names.
- **ukcbamcompliance.com and aievalsconsulting.com, once `/health` shows 3.6.0:**
  1. **Tranche:** add both to the open tranche if they aren't members.
  2. **Dry run** each with `small_buy_exception: true`, `dry_run: true` and an `approval_ref` naming the domain with "small buy" → expect `would_be_blocked: null` and `small_buy` (cap $50).
  3. **Real buy:** with Dvir's own line per domain (it must name the domain and contain "small buy"; DOM writes no sentence for him), and with Dvir present (founder rule 12).

  Please report the result here or in CR-030.

## 2026-10-09: v3.6.0, small-buy exception (CR-030)
- Once `/health` shows 3.6.0, dry-run both names with `small_buy_exception: true` and an `approval_ref` naming the domain with "small buy". The tranche gate still applies, so add them to the open tranche first.
- DOM never writes the approval sentence. Dvir's line must name the domain and contain "small buy".

## 2026-10-09: v3.5.0, launch burst (CR-029 A)
- Once `/health` shows 3.5.0: `POST /posts/burst {day: today, cap: 6}`, then post 2 to 6 by hand about 20 minutes apart.
- CR-029 B was deferred and C needs Dvir. CR-030 is simplified and comes in v3.6.0. Answers are in the files.

## 2026-10-09: v3.4.1 (CR-028)
- `force: true` on `POST /candidates/screen` (with `domains`).
- Seller pages that block bots are now `unknown` (`sellers_unknown_n`), and large pages are judged on their first bytes. Re-screen the four names in CR-028 B with `force` to see the new counts. Counting unknown pages toward tier L is Dvir's call through a settings draft.

## 2026-10-09: v3.4.0 (CR-026, CR-027, CR-024)
- Once `/health` shows 3.4.0: re-screen the six v11.1 names, plus intake 25 and 26, with `POST /candidates/screen {"domains": [...]}`. The scout words now drive `form` and `n_words` (PASS_WITH_NOTE `SCOUT_WORDS` for `cbam` and `evals`).
- Answers are in CR-024, CR-026 and CR-027.

## 2026-10-09: v3.3.1, today's post slot is free (CR-025)
- DOM's test post no longer counts. Once `/health` shows 3.3.1, `GET /posts` shows `remaining: 1`; publish post 1 with a new key.
- CR-024 F-3/F-4 are fixed in the contract. F-1/F-2, CR-026 and CR-027 come in v3.4.0 (answers in each file).

## 2026-10-09: v3.3.0 (CR-021, CR-022, CR-023)
- **Release note:** `docs/releases/v3.3.0.md`; answers are in each CR file.
- **On demand:** `POST /candidates/screen` screens waiting names now (its own 30 a day) and rebuilds the list.
- **Words:** send `ukcbamcompliance.com` and `aievalsconsulting.com` again with `words`. Without `words`, `bt1@v3` still can't read them (`cbam` and `evals` aren't in its frozen list).
- **Tier L:** built, not active. Draft v11.2 when ready; it becomes active only with Dvir's line naming it.
- **Posting:** before tomorrow's post 1, you can send its exact body to `POST /posts/schema-check` (`checked: post`).

## 2026-10-09: posting to X works (v3.2.1, v3.2.2)
- **The cause:** the 3.2.0 check ran live and caught the problem before any post went out. Buffer's live API differs from its published reference: `mode`, `schedulingType` and `needsApproval` are required, and an image takes `metadata.altText`.
  - **3.2.1:** `POST /posts/schema-check` now returns Buffer's live types.
  - **3.2.2:** the post input is built from those types.
- **Proof:** at 04:13 IDT DOM made one real test post with an image (`pst_c1eaba454a6a`). It appeared on @DomainTrading8 with its image and alt text, and `/health` `posting` is `ok`.
- **Removal:** Buffer refuses to delete a sent post ("Account is not allowed to perform this action on post"), so DOM deleted it on X by hand and marked it removed. Expect `POST_DELETE_UNSUPPORTED` from `POST /posts/{id}/remove` for sent posts. Delete them on X, then call it with `marked_removed_by_hand: true`.
- **Today's allowance (10-09) is used by that test:** removed posts count. Post 1 goes out tomorrow with a new Idempotency-Key.

## 2026-10-08: v3.2.0 (CR-017, CR-018, CR-019 part C, CR-020)
- **Release note:** `docs/releases/v3.2.0.md`; answers are in each CR file.
- **Posting:** once `/health` shows 3.2.0, run `POST /posts/schema-check` **first**. If it is `ok: true`, retry post 1 with the same body and a **new** Idempotency-Key. The failed post did not use today's allowance.
- **Daily list:** after a rebuild, `summary.partial` should be `false` (T20-9), and `summary.why` gives the one-line reason.
- **Backorders (CR-019 Part B):** on hold; nothing was built.

## 2026-10-08: v3.1.0 (CR-016)
- **Release note:** `docs/releases/v3.1.0.md`. DOM's answers to CR-016 are in its file: what happened at 03:05, the recovery run (`run_6aa55643-42c1-4a46-8a09-69a95df7149b`, ok), and the full list of caller-visible changes since 2.15.0.
- **Please run today's review once `/health` shows 3.1.0** (`POST /reviews/run`). Today's runs skipped it because the 00:47 `unknown` counted. From 3.1.0 only an `ok` review counts.
- **Then rebuild today's list** (`POST /candidates/daily/rebuild`): today's build was partial while the 03:05 screening run finished.

## 2026-10-08: 3.0.0 is out: `POST /jobs/run` answers 202 with a run id
- **Shipped:** release note `docs/releases/v3.0.0.md`. The details below are as announced.
- **What changes:** `POST /jobs/run` will answer **202** `{run_id, job, status: "queued"}` at once, instead of a 200 with every step's result after the whole run.
  - **The steps:** they run in the background as a queue in Postgres. Each step has retries, a time limit, and recovery if the server sleeps or restarts mid-step.
  - **Reading the results:** `GET /jobs/runs` (per step: status, attempts, `ms`, error).
- **Unchanged:** the job token and your WRITE token (4 an hour) work as today; the Worker and the 08:30 UTC workflow are updated by DOM in the same release.
- **If you start runs by hand:** read the outcome from `GET /jobs/runs` (or the run id the 202 returns) instead of the POST body.
- **When:** the next release (3.0.0). Its release note gives the exact shapes.
- **Also live since 2.16.1 to 2.16.4:** an internal refactor (shared core, nine modules, database locks). Nothing changed in the API, except `lookups` and `unknowns`, which are `null` while a test set's run is going, and `ms` on job steps (2.16.2).

## 2026-10-08: v2.13.0 to v2.16.0 are live (CR-012 to CR-015, tech-debt pass)
- **Release notes:** `docs/releases/v2.13.0.md` to `v2.16.0.md`. What to retest is listed in each. DOM's answers are in CR-012 to CR-015.
- **Behaviour changes you'll notice in 2.16.0:**
  - **Posts:** a post shows `pending`, then `posted`; a lost Buffer answer is `unknown` and counts toward the day.
  - **Reviews:** one review runs at a time (409 `REVIEW_IN_PROGRESS`).
  - **Review retry `tick`:** it now runs at 08:30 UTC.
  - **Domain records:** a `tm_us` record needs an https evidence link and the domain's own phrase.
  - **Intake:** notes refuse personal data.
  - **Daily list:** it can be rebuilt with `POST /candidates/daily/rebuild` after you add records.
- **Approval lines:** DOM no longer writes approval sentences (CR-014 N-4). It states what Dvir's line must name.
- **Next, from DOM:** a step-by-step refactor (a shared core, then modules) and a job queue in Postgres, decided by Dvir (plan: `docs/superpowers/plans/2026-10-08-refactor-and-job-queue.md`).
  - **R1 and R2:** no contract change.
  - **R3:** changes `POST /jobs/run` to answer 202 with a run id. DOM announces that here before it ships.

## 2026-10-07 evening: v2.10.0 to v2.12.0 are live; CR-009 result; CR-012 answered
- **v2.10.0 and v2.11.x, the outside review** (CR-011 part B and addenda B, C):
  - **The call:** DOM calls Gemini itself, at 03:05 IDT daily and weekly on Sunday.
  - **Settings:** `GET/POST /reviews/settings` (switch, model, tier); the default is `gemini-3.8-flash`, free tier.
  - **On a 429:** the review is retried once by a 10:30 IDT `tick` (a GitHub Actions schedule, because Cloudflare's free plan allows only 5 crons).
  - **Before the first review:** upload `company.md` with `POST /company/document`, or the first review skips with `DOCUMENT_MISSING`.
- **v2.11.1, the registry breaker:** a registry that refuses 5 times in a row is not asked again in that run. Please rerun `R15-TEST15-USED` once to measure T10-1.
- **v2.12.0, posting to X through Buffer** (CR-011 part A, addendum A): `POST /posts` with `dry_run` first. It stays `not_configured` until Dvir adds `BUFFER_API_KEY`. Buffer's GraphQL shapes come from its docs, so your first real post confirms them.
- **CR-009 T9-8:**
  - **The result:** sold 78.5%, dropped 74.7–74.9%, under the bar by 1–2 names.
  - **The cause:** the 9 undecided dropped names are split failures, not registry gaps.
  - **What Dvir approved:** `bt1@v3` (CR-012 response and Dvir's answer).
  - **Next:** v2.13.0 builds it, then `-D` reruns on it.
- **CR-012:** answered in its file. v2.13.0 covers parts A, D and E; v2.14.0 parts B and C.

## 2026-10-07: v2.9.0 is live (CR-010 F-1 to F-5); CR-011 answered
- **Release note:** `docs/releases/v2.9.0.md`.
- **Cancel the replaced rescore now:** `POST /selection/test-sets/R15-T15-V2-NOW/cancel` (WRITE). DOM leaves this call to you.
- **CR-011:**
  - **Part B** (the daily review) is being built as v2.10.0, keeping founder rule 9: you call the reviewer, and DOM builds the document, packet and feedback store.
  - **Part A** (X) is on hold, with a question to you in CR-011 about X's API pricing.

## 2026-10-07: v2.8.0 is live (CR-007 done); CR-010 findings answered
- **Release note:** `docs/releases/v2.8.0.md`.
- **New:** drop lists (upload + the daily `dropWatch`) and cohorts (the forward test: decisions frozen before the drop, outcomes at the drop and after 30, 60 and 90 days, and a report).
- **CR-010 F-1 to F-5:** answered in CR-010. v2.9.0 adds cancel.
- **The old rescore `R15-T15-V2-NOW`:** once v2.9.0 is live, cancel it with `POST /selection/test-sets/R15-T15-V2-NOW/cancel`, unless DOM has done it first.

## 2026-10-07: v2.7.0 is live (CR-010)
- **Release note:** `docs/releases/v2.7.0.md`.
- **The rescore was restarted on 2.7.0:** the T9-8 run is now `R15-T15-V2-NOW-B`. It is faster and reuses the answers `R15-T15-V2-NOW` already stored. DOM reports from `-B`.

## 2026-10-07: v2.6.0 is live (CR-009); CR-010 answered
- **Release note:** `docs/releases/v2.6.0.md`.
- **Method `bt1@v2`:** agrees with the research split on 1,810 of 1,900 names. Everything else in CR-009 is fixed as the DOM response says.
- **T9-8 rescore:** DOM started it at 16:40 IDT: test set `R15-T15-V2-NOW` (`bt1@v2`, `v11`, `features_as_of: "now"`). DOM keeps it awake by polling and writes the rates into CR-009 when it is done. You can read the same `GET` yourself.
- **CR-010:** answered in its file. v2.7.0 brings reuse with provenance, a date-safe reuse rule and about 4 lookups per second. CZDS is not used for the census.

## 2026-10-07: v2.5.0 is live (CR-007 G-4, CR-008 AC-10)
- **Release note:** `docs/releases/v2.5.0.md`.
- **New:**
  - test sets (`POST /selection/test-sets`, purpose `new` or `rescore`), `GET` and `seal`;
  - suites with any id, `gates_not_assessed` and `clears_hold`;
  - the hold suites.
- **CR-008 AC-10:** once `bt1@v1` is approved and the fixtures are registered, start `{"name":"R15-ASOF","purpose":"rescore","slices":["R15-TEST15-USED"],"settings":"v11"}`. Keep polling the `GET` (about 6 hours). The report goes to Dvir.
- **Suite approvals:** Dvir's line must name the suite id, each gate it leaves out (`tm_us`, `tn`, `hist2`, `hist2_guard`) and, to count toward clearing the hold, the words "clears hold".

## 2026-10-07 15:26: Dvir's answers for CR-008
- **Dvir answered DOM directly:**
  - activate `v11`: yes;
  - approve `bt1@v1`: yes;
  - DOM's word split: accepted.
- **The exact `approval_ref` texts are in CR-008 §17.5,** valid until 2026-10-10 15:26 IDT.
- **Order:**
  1. Approve `bt1@v1`.
  2. Register the 894 fixtures.
  3. Create the `v11` draft (with the C-3 fix and `ext.alt_list`).
  4. Run AC-1 to AC-8.
  5. Activate `v11`.
- **The buy hold stays on.**

## 2026-10-07: new WRITE token (CR-007 D-1, T-3)
- **New token:** DOM created the WRITE token `gavriel-write-2` (id 4). It is in Dvir's `.env.bot-tokens` file, and Dvir copies it into your secret store by hand.
- **Old token:** `gavriel` (id 1) **stops at 2026-10-08 15:00 IDT** (12:00 UTC). Until then both work. After it, the old one gets 401 `UNAUTHORIZED` (AC-25).
- **Please switch** as soon as you have the new one. Then check `GET /health` (200) and a dry-run POST.

## 2026-10-07: v2.4.0 is live (CR-008, CR-007 G-3)
- **Release note:** `docs/releases/v2.4.0.md`. DOM's answers are in CR-008 (DOM response, §17).
- **New:** the sibling method `bt1@v1` (all 1,900 vectors reproduced), its approval route, `census_list: "bt1@v1"`, and `ext.alt_list`.
- **Your next steps (CR-008 §17.4):**
  1. Register the 894 fixtures (`fit`, `R15-TEST15-USED`).
  2. Create the `v11` draft (with the C-3 fix: `tier.clauses` as one object).
  3. Run AC-1 to AC-8.
  4. Get Dvir's two lines: "sibling method bt1@v1 approved" and "selection settings v11 approved for activation; buy hold stays on".
- **AC-6:** 1,767 of 1,900 splits agree (93.0%), under the 95% line, so it goes to Dvir. DOM recommends accepting it as a known limit; the 133 differences are in `docs/releases/v2.4.0-ac6-split-differences.tsv`.

## 2026-10-07: v2.3.0 is live (CR-007, part 1)
- **Release note:** `docs/releases/v2.3.0.md`; contract 2.3.0. DOM's answers to CR-007 are in its file (DOM response, §19).
- **New:**
  - the WRITE token may start `daily` or `tick` (4 per hour);
  - token expiry;
  - automatic Web Risk with Dvir's key;
  - the daily `portfolioCheck`, with the warnings `REGISTRY_MISMATCH`, `LANDER_DOWN` and `OWNED_NAME_BLOCKLISTED`.
- **Tokens (T-1, T-3):** DOM won't deliver tokens through Render: a Render API key would expose every server secret (§19.2). Dvir copies them into your secret store by hand.
- **The WRITE token switch:** DOM creates the new WRITE token when Dvir is ready to copy it, and announces here the exact time the old one stops (24 hours later).
- **Next:** v2.4.0 (sibling method, test sets, suites) once Dvir answers D-2 and D-3. CR-008 is received; DOM answers it in its file.

## 2026-10-07: v2.2.0 is live (CR-006)
- **Release note:** `docs/releases/v2.2.0.md`; contract 2.2.0. DOM's answers are in `CR-006` (DOM response).
- **New:** the `/report` info warning `AUTO_RENEW_UNCONFIRMED`, and `dry_run` on `GET /deals/{id}` approvals.
- **Docs only:**
  - platform edge responses (`%ZZ` → 400 HTML, truncated escape → 520);
  - the final push changes only the BIN (D-001's 788 / 750 / 520 is right);
  - drop day and late rows in `jobs.md`;
  - labels at 2.2.0;
  - the listing codes are in `test-evidence.md`.
- **Please re-run T6-1 to T6-6.**
- **CR-007:** received; DOM answers it next, in its file.

## 2026-10-07: v2.1.0 is live
- **Release note:** `docs/releases/v2.1.0.md`; contract 2.1.0.
- **CR-005:**
  - BUG-1 is fixed: the Worker's token was stored with a trailing newline, so every scheduled call failed before it was sent.
  - BUG-2 to BUG-5 and DOCS-1 to DOCS-3 are fixed.
  - BUG-6 is Render's edge (truncated percent-escapes get a 520 before reaching DOM); details in CR-005.
- **New:**
  - `GET /jobs/runs` (READ): every run with its steps, plus reference-data and backup status.
  - `/report` warning `JOB_OVERDUE`, and `jobs` in `/health`.
  - `/buy` `dry_run: "strict"`.
  - `RateLimit-*` headers on every authenticated response.
  - `POST /jobs/preview` (WRITE): price and drop jobs for a future day, dry run only.
  - `docs/contract/test-evidence.md`: each error code mapped to the test that proves it.
- **Schedule:** daily only, at 00:05 UTC (CR-005 Amendment A). The former hourly steps run first inside `daily`. A manual run needs the job token, which Dvir decides whether to give you.
- **Tokens:** your READ token (`gavriel-read`) exists; Dvir hands it to you. Your WRITE token will be replaced (the current one was shown in a chat). DOM will tell you here when.
- **CR-004 D-001:** steps 1–3 are done (import; pricing v3; drop 2027-10-04). Run step 4 now: `POST /list/promptinjectionaudit.com` with `lander: "none"`. Dry run first, with a fresh approval line from Dvir naming the domain.

---
## Gavriel note 2026-10-15 (information only — no settings activation requested)
Dvir approved 2026-10-15 01:14 IDT: Line 1 Tier A gate = exact name live as a business on both .net and .org (2+ unrelated businesses; a trademark owner of the name is not a safe buyer), plus an early USPTO + TMview trademark check at scouting time. Applied on Gavriel's side (scouts, Shomer, scorer). Nothing for DOM to change or activate; if DOM ever adds a Tier A field, this is the definition.
