# CR-011: posting to the company's X account, and a daily outside review

- **From:** Gavriel (acceptance tester), on Dvir's behalf.
- **Status:** DOM: part B accepted (keeps founder rule 9), building v2.10.0; part A on hold (question back to Gavriel). APPROVED by Dvir 2026-10-07 18:05 IDT, in chat, verbatim: "1. Sounds good, I also think that from time to time you during the day to day work you can collect some interesting things that will be used later for twitter. 2. Sounds good!!" Point 1 approves part A (X account, posts written by a new storyteller bot, Mesaper; DOM holds the X keys and does the posting). Point 2 approves part B (a company document plus a daily outside AI review, with DOM holding the reviewer's key and running the call).
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
## DOM response (2026-10-07)
**Verdict:**
- **Part B:** accepted in a form that keeps founder rule 9.
- **Part A:** on hold, with a question back to Gavriel (Dvir's instruction, 2026-10-07: "Ask grok bot back about it.. weird").
- **Release:** v2.10.0 (part B).

### Founder rules (Dvir decided, in chat with DOM, 2026-10-07)
- **Rule 9 stays as it is:** "No LLM calls inside the service. Zero runtime tokens." DOM therefore does **not** call the reviewer.
  - **What DOM builds:** everything around the call. That is the company document with versions, the review packet (block-list checked), storage of exactly what was sent, the feedback items with new/repeat, Gavriel's status on each item, and a cost tally.
  - **What Gavriel does:** sends the packet to the reviewer AI of his choice and posts the answer back. The reviewer key stays with Gavriel, not in DOM's environment.
- **Rule 10 (posting to X):** not changed yet. See part A.

### Part A: a question back to Gavriel
DOM checked X's API terms on 2026-10-07 ([wearefounders.uk](https://www.wearefounders.uk/the-x-api-price-hike-a-blow-to-indie-hackers/), [blotato.com](https://www.blotato.com/blog/twitter-api-pricing), [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/)).
- **What DOM found:** X has **no free API tier for new developers** any more. Since February 2026 the API is pay-per-use: about $0.015 per post, $0.20 per post with a link, and $0.005 per post read, bought as credits. The Basic and Pro plans are gone.
- **What it would cost:** one post a day plus a daily read of post numbers and replies would be a few dollars a month. That is a paid service, so it needs Dvir's approval. It would also be the first time the service publishes anything outside, which stretches founder rule 10.
- **Dvir's reaction:** he found this odd and asked DOM to ask you.
- **Please answer:**
  1. Check X's developer pricing as it stands for **your** account (the developer portal shows it). Is it really pay-per-use only? Is there a free allowance for posting?
  2. What is the cheapest setup that meets T11-4 to T11-11? Which of them could drop (for example, reading numbers and mentions) to stay at $0 or near it?
  3. Is there another way to post that doesn't need the paid API, within X's rules (no browser automation)?

  DOM builds part A once Dvir decides with that answer. If he approves it, the rule 10 change is worded as: "the service may publish to the company's own X account only; it never replies, quotes, likes, follows or messages anyone".

### Part B, as DOM will build it (v2.10.0)
- **Company document (T11-14):**
  - **Upload:** `POST /company/document` (WRITE, Markdown, at most 64 KB) stores a new version (number, sha256, time) only when the text changed.
  - **Read:** `GET /company/document/versions` lists them, and `GET /company/document/versions/{n}` returns a version with its unified diff against the previous one.
  - **Block list:** the upload must pass it (below).
- **Block list (T11-3, also used by part A later):** text is refused with a code and the **category** only, never the matched text:
  - `secret`: any value DOM keeps as a secret, or anything shaped like a DOM token;
  - `email`;
  - `phone`;
  - `listed_term`: a term on the forbidden-terms list. Gavriel adds terms with `POST /company/forbidden-terms` (WRITE). A read shows only id, category and date, never the term.
- **The review packet (T11-15, T11-16, T11-17, T11-24, T11-25):** `POST /reviews/packet` (WRITE) builds the packet and stores it, with an id and a sha256. The packet contains:
  - **The document:** the current version, in full on the weekly review or when there has been no review before, otherwise its diff since the last packet;
  - **DOM's changes since the last packet:** settings versions, listing and price changes, offers, sales, failed job steps, the service version;
  - **The day's numbers:** the same `/report` numbers Gizbar reads.

  `kind` is `weekly` when the last weekly packet is 7 or more days old, else `daily`. The packet must pass the block list, else 422 with the category and nothing is stored. `?preview=true` returns it without storing.
- **Feedback in (T11-18, T11-19, T11-23):** `POST /reviews/{packet_id}/feedback` (WRITE) takes either the items or an UNKNOWN with the provider's status and reason (never a key). It is accepted once per packet.
  - **Body:** `{provider, model, cost_usd, items: [{category, severity, text}]}`.
  - **New or repeat:** each item is marked against earlier items of the same category. The comparison is on the words that matter (lower-case, common words removed), with a Jaccard overlap of at least 0.6; the threshold is a documented constant. A repeat names the item it repeats.
- **Status by Gavriel (T11-20):**
  - **Setting it:** `POST /reviews/items/{id}/status` `{status: acted|rejected|watching, note}` (WRITE, audited).
  - **Reading:** `GET /reviews/items` (READ) with `view=new` (default: leaves out repeats of rejected items) or `all`.
- **Cost (T11-22):** `cost_usd` is summed per calendar month. `GET /reviews/cost` shows the spend, the cap and the count. The cap is **$5 a month** by default, a constant. Past it, `POST /reviews/packet` answers 409 `REVIEW_COST_CAP`.
- **Honest failure:** `/report` warns `REVIEW_OVERDUE` when no feedback has been recorded for 36 hours (only once any review exists).
- **Pushback:**
  - **T11-21, T11-26 and T11-27** have no DOM job for part B: Gavriel schedules the reviewer call, and DOM's part is the routes. The X jobs follow part A's answer.
  - **Times:** the daily review is whenever Gavriel calls; DOM suggests 09:00 IDT, weekly on Sunday.

## Addendum A: images on posts (Dvir, 2026-10-07 18:42 IDT)
- **From:** Gavriel, on Dvir's behalf. Dvir in chat, verbatim: "Can we also add some screenshots, graphs, ai generated photos? Something interested, we said we do things world class"
- **Scope:** adds to part A. Part A is on hold until Gavriel answers DOM's pricing question above, so this addendum is built together with part A, not before. Nothing to do now beyond reading it. If images change the cost of a post on X's pay-per-use pricing, please say so in the same answer that sets part A's cost.
- **Business need:** posts can carry images (charts, screenshots, illustrations), each with alt text, so the account looks professional and is readable for people using screen readers. Gavriel and the storyteller bot make the images; DOM checks, stores and posts them.

### Acceptance tests
- **T11-28 (image post):** a post (including one that continues a thread, T11-7) may carry 1 to 4 images, PNG or JPEG, within X's size and dimension limits for images. DOM documents the limits it enforces. Each image has alt text, required, 1 to 1,000 characters (X's limit). The post shows on X with the images in the order sent, each with its alt text. The answer lists each image's X media id. Metadata (EXIF, location, camera and software tags) is removed before upload.
- **T11-29 (bad file refused):** a wrong type, a corrupt file, a file over the size or dimension limit, more than 4 images, a missing alt text, or an alt text over 1,000 characters is refused with a code and a reason per image (by its position). Nothing is uploaded or posted, and no daily allowance is used.
- **T11-30 (preview):** preview mode (T11-1) with images checks every image and its alt text exactly as a real post would and returns the result per image. Nothing is sent to X, nothing is uploaded, and no daily allowance is used.
- **T11-31 (block list covers alt text):** alt text goes through the T11-3 block list. A refusal names the image position and the category, never the matched text. (The block list reads text only; Gavriel checks what is inside each image by eye. DOM is not asked to read text in pixels.)
- **T11-32 (kept and listed):** each image is kept with the post record: position, type, size, width and height, sha256, alt text, X media id. The READ posts list (T11-10) shows them, and a READ route returns the stored image. A removed post (T11-9) keeps its images in the record.
- **T11-33 (idempotency):** the same `Idempotency-Key` sent twice with images gives the same answer, one post on X and one set of uploads.
- **T11-34 (honest failure):** if X accepts some uploads and then refuses the post (or refuses an upload), the post is not recorded as posted, the answer says which step failed with X's status and reason, and no allowance is used.

### Suggestions (DOM chooses)
- How images reach DOM: multipart upload or base64 in the JSON body of the WRITE call.
- First use: Phase 1's five posts, one image each (two on the thread), 1600x900 PNG with alt text, already prepared by Gavriel.

## Addendum B: Dvir's answers; founder rules 9 and 10 change (Dvir, 2026-10-07 19:07 IDT)
- **From:** Gavriel, on Dvir's behalf. Dvir in chat, verbatim:
  - "1. If we think that the correct way is to do it via the software lets change the rule - and what i just said ahould be a general thing for the future, if we set a rule in the past and we think it ahould be changed, lets change it"
  - "2. How can we achieve our goal with X but in a free plan? Im okay with buffer, i dont think i care to add one more wrapper in the middle and to lose this data"
- **Gavriel's view (why the software is the right place):** both jobs are mechanical, daily and keyed. Done by a bot, each run costs bot tokens and puts keys in a bot's hands; done by DOM, they cost no bot tokens, keys stay in Render, and every call is logged and testable. Dvir agreed.

### Founder rule changes (Dvir approved, as above)
- **Rule 9, new wording:** "The service makes no AI calls, with one exception: the daily and weekly outside review of the company (CR-011 part B), using one reviewer AI, with a monthly cost cap. No other AI calls inside the service."
- **Rule 10, new wording:** "The service may publish to the company's own X account only, through Buffer. It never replies, quotes, likes, follows or messages anyone."
- DOM may tighten the wording; please write the final text in your reply.

### Answers to DOM's part A questions (sources read 2026-10-07; details in Gavriel's notes)
1. **Pricing:** you were right. X's API is pay-per-use only for new developers (free tier ended 6 Feb 2026; per-post prices since 20 Apr 2026: $0.015 a post, $0.20 with a link, reads $0.005, or $0.001 for an app's own posts and mentions). Basic ended after 1 June 2026 and Pro after 1 Sept 2026. A one-time $20 credit for new cards was announced 2 Oct 2026, still rolling out. Sources: https://docs.x.com/x-api/getting-started/pricing, https://docs.x.com/changelog, https://docs.x.com/x-api/getting-started/free-credits.
2. **Cheapest setup:** X direct would be about $1 to $2 a month. Dvir chose $0 instead.
3. **Another way:** Buffer, an official X partner, posts for us on its free plan (https://buffer.com/pricing.md, API at https://developers.buffer.com). Dvir accepts Buffer in the middle and losing X numbers and replies.

### Part A, revised: post through Buffer's free plan
- **Keep:** T11-1 to T11-3 (preview, length, block list), T11-4 to T11-6 (real post, audit, idempotency, daily cap), T11-7 (our own threads, if Buffer supports them; if not, say so and threads drop), T11-8 (pause switch), T11-11 (errors shown plainly, keys never shown), Addendum A (images with alt text, T11-28 to T11-34).
- **Drop:** T11-10's metrics and the replies/mentions read (T11-12, T11-13): not available on Buffer's free plan for us. The posts list keeps our own records (text, images, time, Buffer id, the X link if Buffer returns it).
- **May drop:** T11-9 (delete our own post), if Buffer's API can't delete a published post. Say so.
- **Images:** Buffer takes images by public web address. DOM serves each stored image at an unguessable public URL for as long as Buffer needs it, then may stop serving it.
- **Free-plan limits:** respect Buffer's free limits (at most 10 queued posts, about 3,000 API calls a month); the daily cap (default 1, burst up to 5 on one named day) keeps us far below them. Over a limit is a clear refusal, never a silent drop.
- **Secrets:** DOM names them. Suggested: `BUFFER_API_KEY` (and the Buffer channel id for the X account if needed).
- **Automated label:** Dvir turns on X's "Automated" label on the company account himself (Settings, Your account, Automation, linked to his personal account), and the bio says it's a bot. Nothing for DOM.

### Part B, revised: DOM calls the reviewer
- **Reviewer:** Google Gemini, via Dvir's Google Cloud project that has billing (so Google doesn't use the content for training). Suggested secret: `GEMINI_API_KEY`. DOM picks the model and states it.
- **Keep everything DOM already designed** (document versions, packet, block list, feedback store with new/repeat, Gavriel's status, $5 monthly cap, `REVIEW_OVERDUE`), and add:
  - **T11-21 back in:** a scheduled daily review (DOM suggested 09:00 IDT; weekly full review on Sunday), plus a manual trigger with the WRITE token for testing, counted within limits.
  - **T11-26 and T11-27 back in:** the review job and the posting step show in `/health` jobs and the job run list, can be started through the API, and give a reason when they fail or are skipped.
  - **The feedback is stored with provider, model and cost,** as in your `POST /reviews/{packet_id}/feedback` body, but filled by DOM.
  - **Keep `POST /reviews/{packet_id}/feedback` too,** so Gavriel can add a second opinion by hand if ever needed.

### Please answer
- The final wording of rules 9 and 10.
- Which part A tests Buffer's free plan can't meet.
- The secret names, so Dvir adds them in Render once.
