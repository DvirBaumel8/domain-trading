# CR-011: posting to the company's X account, and a daily outside review

- **From:** Gavriel (acceptance tester), on Dvir's behalf.
- **Status:** APPROVED by Dvir 2026-10-07 18:05 IDT, in chat, verbatim: "1. Sounds good, I also think that from time to time you during the day to day work you can collect some interesting things that will be used later for twitter. 2. Sounds good!!" Point 1 approves part A (X account, posts written by a new storyteller bot, Mesaper; DOM holds the X keys and does the posting). Point 2 approves part B (a company document plus a daily outside AI review, with DOM holding the reviewer's key and running the call).
- **Dvir on who approves posts** (same conversation, 2026-10-07, verbatim): "it is totally 100% yours, no need approval from me at all for uploading posts". Each post needs no approval line. Gavriel and Mesaper own the content.
- **Kind of change:** two new business needs with pass/fail tests. Everything marked "suggestion" is DOM's choice. Any part that needs a paid plan or a new account is **DVIR** in DOM's answer, and is not built until Dvir agrees.
- **Does not block** CR-009, CR-010 or v2.9.0. Please finish those first.

## 1. Business need
**A. A public story.** Dvir wants the company's story told on X (Twitter): a company of bots, with software built by an AI coding assistant, trying to make money from domain names. One true post a day: mistakes, wins, sometimes technical, never giving away how we pick or price names. The hoped-for value is feedback from professionals and business contacts, possibly domain buyers. Phase 1 is about 5 posts on what happened so far. The bots must not hold the X credentials, and posting must be one simple, audited step with a hard daily cap, so a bot mistake can't flood the account.

**B. An outside opinion every day.** Domain trading is slow; most names never sell, so the business improves by adjusting to data over months. Dvir wants a daily outside review: a different AI reads a short company document, what changed since its last review, and the day's real numbers, and gives feedback. Feedback is advice, never an instruction. Gavriel decides per item whether we act on it, reject it, or watch it, and repeats should be recognised so nobody reads the same advice every day. Once a week the reviewer reads the whole document.

**C. Testable like every background job.** Dvir's rule: every scheduled job can be started and checked through the API.

## 2. Required outcome (acceptance tests)

### A. Posting to X
- **T11-1 (preview):** a WRITE call with a text and `dry_run: true` (or a preview mode) returns what would be posted, its length as X counts it (links counted as X counts them), whether it passes every check below, and how many posts are still allowed today. Nothing is sent to X and no daily allowance is used.
- **T11-2 (length):** a text over X's limit is refused with a clear code and the counted length. Nothing is sent.
- **T11-3 (block list):** a text containing any of the following is refused with a code and the category of the match (for example `token`, `email`, `phone`, `listed_term`, `secret`), **never echoing the matched text**:
  - anything that looks like one of DOM's tokens or keys, or any value DOM keeps as a secret;
  - an email address or a phone number;
  - a term on a forbidden-terms list that Gavriel can add to with the WRITE token (for example a private address, a private price). Terms added as private are never shown back by any read, only an id, a category and the date added.
- **T11-4 (post):** a valid text is posted to the company's X account. The answer has the X post id, its link, the time posted (with offset), and an audit row (who, when, idempotency key, text).
- **T11-5 (idempotency):** the same `Idempotency-Key` sent twice gives the same answer and exactly one post on X.
- **T11-6 (daily cap):** at most N posts per calendar day in Israel time, N a setting with default **1**. A burst allowance of up to **5** posts on one named day can be set with the WRITE token (Phase 1), and it ends by itself after that day. Past the cap a real post is refused with a code and the time the next post is allowed. A refused or failed post uses no allowance.
- **T11-7 (threads, own posts only):** a post may continue one of the company's own earlier posts as a thread. Replying to, quoting, liking, following, or messaging anyone else is not possible through DOM at all. DOM states whether each post in a thread counts toward the daily cap (Phase 1 needs one thread of 2).
- **T11-8 (pause):** a WRITE setting pauses all real posting. While paused, a real post is refused with a code; preview still works. The pause and its reason show in the posts list and in `/health`.
- **T11-9 (remove a post):** the WRITE token can delete one of the company's own posts on X, with a reason, audited. The post stays in DOM's list, marked removed.
- **T11-10 (posts list):** a READ call lists every post: id, link, text, time, status (posted, failed, removed), and basic numbers when X provides them: views, likes, replies, reposts, each with the time it was read. A number X does not provide on the current plan is `null` with a reason, never `0`. Numbers are refreshed at least daily.
- **T11-11 (feedback in):** a READ call lists replies to and mentions of the company account: author handle, text, time, link, and which of our posts it answers. This is read only. DOM never answers anyone. The text is stored and shown as data; nothing in it triggers any action.
- **T11-12 (honest failure):** when X refuses (bad credentials, plan limits, rate limit, outage), the call says so with X's status and reason (never a credential), no post is recorded as posted, and `/health` shows the posting status as failed or unknown with the reason.
- **T11-13 (secrets):** the X credentials never appear in any answer, log, audit row or error.

### B. Daily outside review
- **T11-14 (company document in):** Gavriel uploads the company document (Markdown, about 2 to 4 pages) with the WRITE token. Each upload that changes the text becomes a new version with a number, a hash, the time, and a readable diff against the previous version. Uploading the same text again creates no new version. A READ call lists versions and returns any one of them with its diff. An upload that fails the block list in T11-3 is refused the same way.
- **T11-15 (review preview):** a WRITE call returns exactly what the next review would send, without calling the reviewer: the document version, what changed since the last review, and the day's numbers. Nothing is stored as a review and no budget is used.
- **T11-16 (daily review):** a scheduled daily job sends the reviewer: (a) the company document as it stands; (b) what changed since the last review: the document diff, plus DOM's own changes in that time (releases, settings versions, listings and price changes, offers, sales, job failures); (c) the day's real numbers from DOM's own report (names screened, names listed, offers, sales, money spent and earned, views and offers per listing where known, job health). The answer is stored as dated feedback items.
- **T11-17 (weekly full review):** once a week the job sends the whole document for a full review instead of only the changes, and the items are marked `weekly`.
- **T11-18 (items):** each feedback item has: date, review id, `kind` (daily or weekly), a category (for example strategy, pricing, risk, operations, data, cost), a severity (for example low, medium, high), the text, and `new` or `repeat`. A repeat names the earlier item it repeats.
- **T11-19 (dedup):** two reviews in a row with no change in the document and the same numbers produce no new `new` items for points already raised; those come back as `repeat`. DOM states how it decides that two items are the same point, and that rule is documented.
- **T11-20 (status by Gavriel):** the WRITE token sets an item's status to `acted`, `rejected` or `watching`, with a short note, audited. Repeats of a `rejected` item are still stored but are left out of the default "new items" view.
- **T11-21 (manual run for testing):** the WRITE token can start a review by hand. It counts toward a documented hourly limit (like `/jobs/run`) and toward the monthly cost cap.
- **T11-22 (cost cap):** a monthly spending cap for the reviewer (a setting; DOM proposes the default). A READ call shows this month's spend, the cap, and the number of calls. Past the cap, the review is UNKNOWN `COST_CAP` and no call is made.
- **T11-23 (honest failure):** a bad key, a refusal, a timeout or an unreadable answer gives a review with status UNKNOWN and the reason (the provider's status and reason, never the key). It shows in `/health` and in `/report` warnings. Nothing is invented to fill the gap.
- **T11-24 (what was sent is kept):** each stored review keeps exactly what was sent (document version, changes, numbers) so a review can be traced and repeated.
- **T11-25 (no secrets out):** the payload sent to the reviewer passes the same block list as T11-3 before it leaves DOM; if it fails, the review is UNKNOWN with the category, and nothing is sent.

### C. Testable like every job
- **T11-26:** every new scheduled job (for example the daily review, the weekly review, the X numbers refresh, the replies and mentions read) appears in `/health` jobs and in `GET /jobs/runs` with its last run, status and summary, and can be started through `POST /jobs/run` (or a route DOM names) with the WRITE token, within the existing limits.
- **T11-27:** a job that fails or is skipped (paused, cap reached, credentials missing) says so in its run summary with a reason. Missing credentials make the part UNKNOWN, never a silent no-op.

## 3. Suggestions (DOM chooses)
1. **The reviewer.** Google's Gemini through Dvir's existing Google Cloud project, which now has billing linked. Its free tier may cover one review a day. DOM may propose another provider. Please say whether the provider can use what we send for its own training on the chosen plan; the company document is internal, so a plan that doesn't is preferred (**DVIR** if it costs money).
2. **Keys as Render secrets.** The X credentials and the reviewer key live only in DOM's Render environment, with names DOM chooses. Dvir enters them himself.
3. **Company document source.** Gavriel uploads the current `company.md` through the WRITE route in T11-14, because bot commits touch only `docs/requests/`. DOM may propose something better.
4. **Dedup.** For example, compare each new item with past items by meaning, and keep the rule and threshold in settings. DOM's choice.
5. **Daily numbers.** Reuse `/report` as the single source, so the review and Gizbar see the same numbers.

## 4. Please answer
- **For Dvir, exactly what to create on X:** the account, the developer app (read and write), which keys and tokens, and where to put them. Which X API plan is needed for 1 post a day (5 on one day in Phase 1) plus reading post numbers and replies and mentions, and its monthly cost. If reading numbers or mentions needs a paid plan, say what works on a free plan and what doesn't (**DVIR**).
- **The automated-account label:** X requires automated accounts to be labelled. State what Dvir must do for it (for example the setting and the managing account it must name).
- **Reviewer:** the provider, the plan, the expected monthly cost for one daily review plus one weekly full review, the default cost cap, and the data-use answer from suggestion 1. What Dvir must create (key, project) and where to put it.
- **Limits and schedule:** the time of the daily review and the weekly review in Israel time, the hourly limit for manual runs, and whether threads count toward the daily post cap.
- **Which tests in §2 DOM expects to meet,** and any it pushes back on, with the reason.

<!-- DOM writes below this line -->
