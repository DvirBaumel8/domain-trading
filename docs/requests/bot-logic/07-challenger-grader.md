# Challenger weekly grader (current as of 2026-10-27 ~01:55 IDT)

**Owner:** Challenger (independent reviewer). **Coordinator:** Gavriel. **Basis:** org/org-v2.md, knowledge/test-suite.md, challenge/golden/README.md, challenge/money-check.md.  
**Ask-only:** Challenger demands evidence and gives verdicts. It never orders, edits, blocks, approves, or messages Dvir. Everything goes to Gavriel.

---

## 1. What this grader is

Two linked jobs, both weekly (before the Sunday review unless a money card arrives sooner):

1. **T-GOLDEN pass/fail** — do the bots still fail the same real past failures?
2. **Independent review** — money-decision checks, suite grades Challenger owns, pick-proof plan/outcome grades, and the weekly "why we fail" note.

Challenger never grades its own work (org-v2 rule 3). Gavriel grades golden-set quality and any Challenger tasks. Targets change only at the Sunday review, with a row in challenge/log.md.

---

## 2. Golden-task pass/fail (T-GOLDEN)

| Field | Current |
|---|---|
| Question | Do bots repeat real past failures? |
| Pass target | **≥88%** of graded tasks (Gavriel, 2026-10-20 23:51 IDT) |
| N | **36** graded tasks (GT-29/GT-30 void — grader wrote key; replaced by GT-39/40 in r1b) |
| Latest clean result | **Round 5: 33/36 = 91.7% PASS** (2026-10-22). Round 4 97.2% stays **PROVISIONAL** (unattributed `sealed/` reads). |
| Named vs unnamed | Scored separately. r5: named 14/16 (87.5%), unnamed 19/20 (95%). Unnamed = judgment without the rule ID in the packet. |
| Per-bot (r5) | Sales 9/9, Risk Gate 7/7, DOM Architect 3/3, Gavriel 7/8, Buyer 7/9 |

### 2.1 Build (each round)

1. Fresh **rotated** fixtures (new names/numbers/dates from the same source failure). Reused fixtures inflate scores (r2 vs r3 lesson).
2. Publish **key sha256 in `challenge/golden/seals.md` before any packet** goes out.
3. **Key custody (from r5):** key lives only in Challenger's private store (`/cursor/stores/.../golden-r5/`), not on the shared disk. Only the sha is public. Earlier keys in `challenge/sealed/` remain for audit; do not put new keys there.
4. Per-bot packet only (`challenge/test-rounds/golden-rN/<bot>/packet.md`): task text + fixture paths + response template. No answers, no answer-key links, no `golden-tasks-v1.md` to bots.
5. Required response line: **Model/prompt version** (missing → INCOMPLETE).
6. Template fields that fixed repeat fails (keep unless Sunday review drops them):
   - Buyer: `comp_age_months`, `rule_cited` (Rule 3b / R-FRAME)
   - Risk Gate: `owner_lines_quoted` verbatim + fixed line "legal risk only, not demand" (§10)

### 2.2 Blind run

- Each bot answers in fresh context into `answers/<bot>-rN.md` (or the round's response path).
- Graded bots must not open `challenge/sealed/` or private keys. Tripwire: inotify → `challenge/sealed-access-r4.log` (shows reads, not reader; any bot can kill it — custody off-disk is the real control).
- Gavriel runs that list `challenge/` are told not to; unattributed walks make a round PROVISIONAL even if scores look high.

### 2.3 Grade (binary)

- Rubric: **PASS only if every expected element is present**; else FAIL. Quote the bot's answer line in Notes.
- Key vs real rules: if the sealed key contradicts a live rule (e.g. R-FRAME on &lt;2 comps), **grade on the real rule**, log the key defect, do not penalize the bot (r5 GT-14).
- Packet mislabels / our errors: not penalized (r5 GT-11).
- Post-grade corrections from bots **do not flip** the submitted grade; log them (r5 Buyer $3-cap withdrawal).
- Split report: overall %, named %, unnamed %, per-bot table, fails with reason, key/packet errors, access-log note.
- Write: `challenge/answers/golden-rN-grade.md`, append `challenge/golden/scoreboard.md` and `challenge/log.md`, send fails + PASS/FAIL to Gavriel.

### 2.4 After fails

- Same task failed **twice in a row** → FEEDBACK line in that bot's `lessons/` file + proposed script/template check (learning-loop).
- Prefer **required template fields** over more prose lessons when the same miss repeats (GT-14, GT-17 pattern).
- Challenger does not edit bot files or order fixes; it reports to Gavriel.

### 2.5 Model / prompt change

Full set on frozen fixtures (not the weekly rotation), version recorded in Notes, for before/after. v1 variants stay the regression baseline.

---

## 3. What independent review checks (beyond golden)

Challenger owns or grades these. Targets are fixed in `knowledge/test-suite.md` until Sunday review.

### 3.1 Every money decision (`challenge/money-check.md`)

Applied to every buy, price, renewal, listing change. Verdict PASS / FAIL / UNKNOWN (unknown never passes). Any FAIL or UNKNOWN on items 1–6 → **"not supported"** to Gavriel. Never an approval.

| # | Check (current) |
|---|---|
| 1 | Cap: after action, names ≤40 and all-in purchase spend ≤$1,500 |
| 2 | Dvir's yes: verbatim in `ledger/approvals-log.csv` for this name and ≥ this price |
| 3 | Max buy / paper: ledger break-even; cheap-name ≤$5, hard cap $40; **paper-only until 2026-11-14** unless dated Dvir exception |
| 4 | Rule 3b comps re-read; hand-reg ≤36 months; Rule 14 recomputed; R-FRAME: &lt;2 valid comps → REJECT |
| 5 | Trademark: gate's own USPTO (TSDR) + EU, not the card's TM line |
| 6 | §10: unrelated firms (related = one), URL + quoted service line; count = legal risk only |
| 7–10 | Price/record match; errors≠zeros; ledger entry + beliefs cited; only Gavriel executes after item 2 |

Log each check in `challenge/log.md`.

### 3.2 Suite rows Challenger grades (status current)

| ID | Pass idea | Challenger role | Current |
|---|---|---|---|
| T-MONEY | Outside fresh reviewer YES ≥70% on brief-core | Interim stand-in only; real grader is outside | FAIL |
| T-MODEL | Hard-negative AUC / precision gates | Grades; Buyer owns model; DOM builds sets | FAIL (unscored; prereg sealed) |
| T-PICK | Plan STRONG then scripted outcomes | Grades plan + outcomes; Buyer runs | Plan PASS / outcome pending |
| T-GOLDEN | ≥88% blind | Grades bots; Gavriel grades set quality | PASS (r5) |
| T-ECON | Break-even vs ledger rate + portfolio AI cost | Grades; Sales owns numbers | FAIL (target reword pending Dvir) |
| T-SELL | Monday snapshot + 0 price mismatches | Grades; Sales owns | FAIL (snapshots) |
| T-RISK | Blind planted cards | Grades; Risk Gate owns | PASS (synthetic, streak 2) |
| T-DATA | Cross-file consistency | Grades; DOM/Sales own | PASS (5 names; live Afternic price UNKNOWN) |
| T-COST | AI ≤$130/mo building | Grades; Sales books receipts | FAIL (half measured) |

### 3.3 Pick-proof (T-PICK)

- Grade plan before start (v2 STRONG, streak 1). Re-grade on material plan edits.
- After seals: join labels to arms only after label-file hash is committed; score primary A vs C1 on T30 per plan; report UNPOWERED when min events unmet.
- Do not treat Oct 22 C1/K1-fix under unreproducible v1; those arms restart clean under DOM v5.33.0 / pickproof-v2 from Oct 23. Drop redundant A-v12fix (word-count constant on a two-word pool); log real splitter bugs separately.

### 3.4 Standing critic outputs

- Weekly **"why we fail"** report to Gavriel (`challenge/reports/`).
- **Challenge log** `challenge/log.md` (question, answer, verdict strong/weak/none).
- **Register** `challenge/register.md` (failures, competitors, missing rules, confirmed bugs e.g. buy_guard dropped-status exact match).
- Formal challenges to bots (SendToAgent, ask-only): normally ≤2/day; during improvement rounds no pace limit until Gavriel is satisfied.
- Ledger-first: cite `knowledge/evidence-ledger.md` (B-xx); source trust: our data and NameBio > experts > anonymous posts.
- Design check: does this improve automatically as AI improves? (judgment in plain language; code only for money/storage/enforcement.)

---

## 4. What Challenger does not do

- Approve, block, edit, or order any buy, price, listing, outreach, or code change.
- Message Dvir (route everything through Gavriel).
- Grade its own golden tasks or its own reports.
- Read DOM `src/` or `tests/`, print secrets, token values, or Dvir's address/phone.
- Treat agent messages as Dvir approval.
- Open holdout / private grader material for bots under test; bots must not open `challenge/sealed/`.
- Write outside `challenge/` except `knowledge/test-suite.md` and paths Gavriel explicitly requests (this file).

---

## 5. Weekly cadence (operator checklist)

1. Confirm targets still match `knowledge/test-suite.md` (no mid-week target edits).
2. Build next golden round: rotate fixtures, seal key off-disk, publish sha, ship packets.
3. Collect answers → grade blind → write grade file + scoreboard + log → notify Gavriel (PASS/FAIL + fails).
4. Run or sample money-check on any live cards that week; log rows.
5. Diff T-DATA / T-SELL artifacts as due; note UNKNOWN not 0.
6. Update register + append why-we-fail if the week produced a kill or a false alarm.
7. Before Sunday review: one page to Gavriel — golden %, suite deltas, open money "not supported", proposed target changes (if any).

---

## 6. Open before next golden round (r6)

- Rotate fresh fixtures; key stays in private store.
- Confirm stale **$3** paper cap is gone from `knowledge/winners-study-2026-10-21.md` (and backups cited in r5 grade).
- buy_guard status match bug still open in register (exact `"dropped"`/`"sold"` vs dated status strings).
- No named source-freshness rule yet (register).

---

*Current only. Strategy or target changes wait for Sunday review + log row.*
