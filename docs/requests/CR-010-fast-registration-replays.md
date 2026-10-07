# CR-010: make registration-heavy test runs fast (target: under 15 minutes)

- **From:** Gavriel (acceptance tester), on Dvir's behalf.
- **Status:** APPROVED by Dvir 2026-10-07 16:37 IDT, in chat, verbatim: "ask DOM to make it shorter and suggest him the 3 items you raised."
- **Does not block CR-009.** Please start the `bt1@v2` rescore of `R15-TEST15-USED` as planned. This request is for every run after it.
- **Kind of change:** a business need with input/output targets. The three ideas in §3 are suggestions; how to get there is DOM's choice.

## 1. Business need
CR-009 says the `bt1@v2` rescore of the 894 TEST15 fixtures takes about 6 hours of paced lookups. That is 894 names times about 20 siblings, so about 18,000 single registration questions to the .com registry, sent slowly so the registry does not block DOM.

This is not a one-time cost. The same kind of run comes back:
- every time a selection setting or a sibling method changes (a new rule version, a new method version, a new test set);
- in the weekly forward test (CR-007);
- whenever Gavriel reruns a replay through the API to accept a release (T9-8 and similar).

Six hours per run slows every rule change to one try a day. Dvir wants the loop to be fast, so each improvement can be tested and accepted the same hour.

## 2. Required outcome (acceptance tests)
- **T10-1 (rerun):** a second `rescore` of `R15-TEST15-USED` on `v11` with `bt1@v2` and `features_as_of: "now"`, started within 7 days of the first, finishes in **under 15 minutes** from start to `done`, with the same decisions as the first run except names whose registration really changed.
- **T10-2 (changed method):** a rescore with a method version that changes the split of at most 10% of names finishes in **under 15 minutes**. Only the siblings that are new should need fresh answers.
- **T10-3 (first run on a new set):** DOM states in its reply the fastest time it can reach for a set of about 900 names with no prior answers, and what (if anything) Dvir must provide to reach under 15 minutes. Dvir decides.
- **T10-4 (honest data):** every registration answer used in a run shows where it came from and when it was read (for example `source` and `checked_at`), and the run reports how many answers were fresh and how many were reused. A run can be told the oldest answer it may reuse (for example a maximum age in days), and the default is documented.
- **T10-5 (correct dates):** reusing answers never breaks `features_as_of`. A run that asks for registration as of a past date never uses an answer read for a later date as if it were older, and the reverse.
- **T10-6 (live screening unchanged):** screening one real name still gives a census answer in seconds, and its answers may feed the same store.
- **T10-7 (registry safety):** no run gets DOM rate-limited or blocked by a registry. If a source refuses, the run says so (as UNKNOWN with a reason) instead of slowing silently.

## 3. Three suggestions (DOM chooses)
1. **Reuse answers.** Keep every registration lookup with its date and reuse it for a set time (for example 7 days). Most of the 18,000 siblings in the `bt1@v2` rescore will already have been asked once by tonight, and only about 5% of splits changed from `bt1@v1`, so a rerun would be mostly reused answers.
2. **Ask in parallel.** Send several lookups at once, up to what each registry allows, instead of one at a time. Several sources may also be used side by side (for example Verisign RDAP plus a second source), if their terms allow it.
3. **Use the full .com list.** Verisign publishes a daily file of every registered .com name through ICANN's Centralized Zone Data Service (CZDS), free with an approved account. With a local copy, 18,000 checks take seconds and send no questions. DOM dropped CZDS in CR-007; please say whether it is still the right answer here, whether its terms allow this use, and exactly what Dvir would need to do (account, approval time). Past-date answers would need the daily files kept from the day collection starts, so this does not help replays of older dates by itself.

## 4. Please answer
- Which of the three (or something else) DOM picks, and which tests in §2 it expects to meet.
- The time DOM expects for T10-1, T10-2 and T10-3.
- Whether Dvir needs to do anything (for example open a CZDS account).

<!-- DOM writes below this line -->
