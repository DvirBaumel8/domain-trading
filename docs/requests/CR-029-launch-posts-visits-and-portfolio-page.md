> Status: DOM: A in v3.5.0 (burst cap 6); B deferred; C needs Dvir (no-frontend rule). Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT. Asked for by Dvir on 2026-10-09 13:51 IDT.

# CR-029: launch burst for the first 6 posts, visit counts per domain, and a one-page portfolio view
| Field | Value |
|---|---|
| CR id | CR-029 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-09 IDT |
| Priority | A: **P1** (the launch is waiting on it). B and C: P2, needed before the next names are bought. |
| Based on | Live API 3.4.x: `GET /posts` (allowance `today_cap 1, used_today 1`; post 1 `pst_dc2228d9cbb3` posted 13:40 IDT), `GET /portfolio` (1 name), contract `endpoints.md` §Posting to X and §Reads, `reports.md` §per_domain. No src/ or tests/ read. |

Dvir's words (2026-10-09 13:51 IDT), shortened: (1) we decided to start with the 5 posts (now 6) and post one a day only after that; (2) can we know how many people visited our sale pages, e.g. promptinjectionaudit.com; (3) now that we'll buy more domains, I want a one-page view of the company's domains with basic data.

---

## A. Launch burst: the first 6 posts, then one a day

### 1. Business need
The launch plan is 6 posts: the 5 phase-1 posts plus one extra post (post 4 is a thread of 2, which counts as one post). Post 1 went out today at 13:40 IDT, so **5 are left**. The daily cap is 1, and `POST /posts/burst` allows a cap of 2 to 5 for **one** day. With post 1 already counted, a burst today gives at most 4 more, so the 6th would still wait until tomorrow. Dvir wants the whole launch out together, then one a day.

Posting 5 posts within a minute or two looks like a bot dump to readers and to X's spam filters. They should go out spaced out.

### 2. Rules
- **R-A1 Launch allowance.** A one-time setting on top of the daily cap, for example `posts.launch_remaining` (start value **5**, set by a WRITE call with Dvir's approval text). Each `posted` or `unknown` post on any day uses the daily cap first and then the launch allowance. A `failed` post uses neither (same as today). When the allowance reaches 0 it stays 0. It can't be raised again without a new call that carries an `approval_ref`.
  - An alternative is fine if it is simpler for you: let `POST /posts/burst` take `cap` up to 6 and count posts already made that day toward it.
- **R-A2 Minimum gap.** While launch posts are being used, two real posts must be at least `posts.min_gap_minutes` apart (default **20**). Earlier: 409 `POST_TOO_SOON` with `details.next_allowed_at`. Dry runs are not limited.
- **R-A3 (nice to have) Scheduled sending.** `POST /posts` with `send_at` (IDT time, at least the gap after the previous post): DOM runs every check now (length, block list, images, Buffer schema), stores the post as `scheduled`, and the next tick sends it. That way the 5 posts don't need someone to call every 20 minutes. If you add this, a scheduled post holds its allowance at creation, a failed send frees it, and `POST /posts/{id}/remove` cancels a scheduled post.
- **R-A4** After the launch, the normal 1-a-day cap applies unchanged. Vendor test posts still never count (CR-025).

### 3. Acceptance criteria
- **AC-A1** Set the launch allowance to 5 → `GET /posts` `allowance` shows `today_cap`, `used_today`, `launch_remaining: 5`, `remaining` (today's total left) and `next_allowed_at`.
- **AC-A2** Post 2 at T → 201. Post 3 at T+5 min → 409 `POST_TOO_SOON` with `next_allowed_at` = T+20 min. At T+20 min → 201; `launch_remaining` goes down by one per post.
- **AC-A3** A post that fails at Buffer → `launch_remaining` doesn't change.
- **AC-A4** After 5 launch posts: the next post that day → 409 `POST_DAILY_CAP`. Next day: one post allowed, as before.
- **AC-A5** (if R-A3) Five posts with `send_at` 20 minutes apart are all `posted` by the tick after their time; one of them removed before its time is never sent and frees its allowance.

### 4. Questions
- **QA-1** Does Buffer's free plan or X limit 6 posts in about 2 hours through one channel? If you know of a lower limit, tell us and we'll space them further apart.
- **QA-2** If R-A3 isn't small, ship R-A1 and R-A2 first. We'll send the posts by hand 20 minutes apart.

---

## B. Visits to our sale pages

### 1. Business need
Dvir wants to know how many people open each domain's sale page, so he can see interest before an offer arrives. Our rules already plan to use this (selection notes: "Afternic views/leads after 30 days", "0 views after 60 days → cold"), but nothing in DOM stores it.

**What we know today (Gavriel, 2026-10-09):**
- `promptinjectionaudit.com` uses Afternic's nameservers (`ns_verified: true`, `lander: afternic`). The page is **Afternic's own for-sale lander**, served by GoDaddy (A records 13.248.169.48 / 76.223.54.146). DOM doesn't serve the page, so it sees no visits.
- Afternic counts them: the portfolio page in Afternic's dashboard has a **Views** column for the last 30 days and a **Leads** column (Request Price inquiries). Each domain's **Statistics** tab shows a daily graph going back 12 weeks, with a **CSV export**, bot traffic filtered (Afternic blog, 2023 and Aug 2024). These stats exist only for domains on Afternic nameservers with an Afternic lander. As far as we know, Afternic has **no public API** for them, and GoDaddy's domain API doesn't return them.
- `GET /portfolio` already counts offers (`offers.count_30d` etc.), but only offers logged through `POST /offers`.
- Moving to our own lander to count visits ourselves isn't worth it: Afternic charges a higher commission when the name isn't on its nameservers at the time of sale (selling playbook §4.3). We keep Afternic's lander.

### 2. Rules
- **R-B1 Visit records.** A store of daily visit numbers per domain and source: `{domain, date (IDT day), source (afternic | dom_lander | dom_link | sedo | other), views, unique_visitors?: int|null, leads?: int|null, referrers?: [{host, views}] | null, imported_from, imported_at}`. Append-only. A newer import for the same domain, date and source replaces the older one in the totals and keeps both in history.
- **R-B2 Afternic CSV import.** `POST /visits/import` (WRITE) takes the CSV exactly as Afternic's per-domain Statistics export produces it (raw text, plus `domain`) and stores one row per day. Unknown columns are kept as `extra`, not refused. An unreadable file gives 422 `VISITS_CSV_INVALID` with the line number. We'll send DOM a real export as soon as Dvir downloads one (`CR-029-reference/`). Also allow manual entry (`{domain, date, views, leads?}`) for when only the 30-day number from the portfolio page is available.
- **R-B3 Automatic pull, only if a sanctioned way exists.** If Afternic or GoDaddy offers an official API or a scheduled report for views and leads, pull it daily in the job, with a key Dvir provides. Don't scrape a logged-in dashboard. If no sanctioned way exists, say so, and the CSV import is the path.
- **R-B4 Privacy-light counter for anything DOM serves.**
  - (a) A future DOM-hosted lander (`lander: custom`) counts visits.
  - (b) A short tracking link per domain, e.g. `GET /go/{domain}` (public), counts the click and redirects (302) to `https://{domain}/`. We can use it in our own X posts and emails to see how many people they send.
  - For both: no cookies, no stored IP. The daily unique count is a hash of IP + user agent + a salt that changes daily, and DOM never stores the raw values. Known bots are excluded by user agent. The referrer is stored as the host only.
- **R-B5 Read API.** `GET /visits?domain=&from=&to=` (READ) returns daily rows plus totals per source. The `per_domain` row (and `GET /portfolio`) gains `visits: {views_7d, views_30d, unique_30d, leads_30d, last_import_at, sources: [..]}`, where every key is present and null means unknown.
- **R-B6 Stale data.** If a listed name with an Afternic lander has had no Afternic import for more than `visits.stale_days` days (default **14**), `/report` shows an info warning `VISITS_STALE`.

### 3. Acceptance criteria
- **AC-B1** Import a sample Afternic CSV of 14 days for promptinjectionaudit.com → 201 with `rows_stored: 14`. `GET /visits` returns them, and `GET /portfolio` shows `visits.views_7d` / `views_30d` summed from them.
- **AC-B2** Importing the same file again → no double count (`rows_replaced: 14`).
- **AC-B3** `GET /go/promptinjectionaudit.com` → 302 to `https://promptinjectionaudit.com/`. The next day's `GET /visits` shows `source: dom_link, views: 1`. The database has no IP, user agent, or cookie stored for it.
- **AC-B4** A bot user agent (e.g. `Googlebot`) on `/go/...` → redirected, not counted.
- **AC-B5** A listed name with no import for 15 days → `VISITS_STALE` (info) in `/report`.

### 4. Questions
- **QB-1** Do you know of any official Afternic or GoDaddy API or report for lander views or leads? (R-B3)
- **QB-2** Is `/go/{domain}` safe as a public route on the free plan (rate limit, open-redirect protection: only domains in our portfolio)?

---

## C. One-page portfolio view (web) and `GET /portfolio` for it

### 1. Business need
We are about to own more than one name. Dvir wants **one page**, usable from his phone, that shows every company domain and the totals, without reading JSON. It must be read-only, private, and look clean and professional (a world-class feel, not an admin table).

### 2. Rules
- **R-C1 Page.** `GET /dashboard` serves one HTML page, read-only. It is mobile-first (works at 360 px wide, also good on desktop), light and fast (no external trackers, no third-party fonts or scripts required), and has a calm, modern design: clear type, a few status colours, and numbers aligned right. It never offers a write action.
- **R-C2 Access.** The page is not public. A dedicated **read-only dashboard credential** (new scope `dashboard`, or the READ scope) opens it, for example by a one-time sign-in link that sets a secure, HttpOnly cookie, so no token sits in the URL or the browser history. The WRITE or job tokens never work here. Sessions expire (default 30 days) and can be revoked. Bad or expired → a plain sign-in page, no data.
- **R-C3 Totals at the top.** Number of domains (by status), **money spent** (sum of `cost`), **yearly renewals** (the sum of renewal prices for names that will renew; names set to drop at first expiry count 0 and are listed as such), **best offer** (amount, domain, date), visits 30d (sum), and the next 3 events (price drops, drop dates, renewal decisions) from `upcoming_90d`.
- **R-C4 One row (card on phone) per domain**, including pending purchases and dropping names. Fields:
  - name;
  - lane (S2…S7, from the strategy label; a manual import shows its category);
  - status: `pending` (open purchase), `owned`, `listed`, `dropping` (listed or owned with a drop date within 60 days, or set to drop at first expiry and in its last 60 days), `sold`, `dropped`, `delisted`;
  - registrar;
  - bought date and cost;
  - renewal/expiry date and renewal cost (or "drop, no renewal" when the plan is to drop);
  - listing: mode, BIN, floor, min offer, and where it's listed (Afternic, Sedo, lander type, export pending or not);
  - visits 7d / 30d and leads (from part B; "–" when unknown);
  - offers (count, highest);
  - next price event.
  - **Not shown: the walk-away.** It is private and must not appear in a page that may be screenshotted. The floor is shown.
- **R-C5 Sort and filter.** Default sort: live names first, then by expiry date. Simple filters by status and lane. A link per domain opens a detail panel (listing history, schedule without walk-away, ledger rows, offers, daily visits chart).
- **R-C6 JSON.** `GET /portfolio` already exists (READ, `per_domain` rows, no pending purchases). Please add the same data the page uses, without breaking current callers: either `GET /portfolio?include=pending,summary` or a new `GET /portfolio/summary`, returning `{totals: {...as R-C3}, domains: [{...per_domain + lane, status_view, bought_on, listed_venues, visits}]}`. The page must be built only from this JSON, so the two always agree.
- **R-C7** All money in USD with the existing pairs (`_cents` + display), dates in IDT, and `as_of` at the top of the page.

### 3. Acceptance criteria
- **AC-C1** No credential → `GET /dashboard` shows the sign-in page, and neither the page nor its scripts carry portfolio data. With the WRITE token → refused.
- **AC-C2** Signed in → the page shows promptinjectionaudit.com: listed, GoDaddy, bought 2026-10-04 for $13.73, expiry 2027-10-04, "drop, no renewal", hybrid BIN $1,488 / floor $967 / min offer $100, Afternic lander, offers 0, next event `drop1_m6` 2027-04-07 $1,088. Totals: 1 domain, spent $13.73, yearly renewals $0, best offer none.
- **AC-C3** The HTML and the summary JSON contain no `walkaway` value anywhere.
- **AC-C4** A dry-run or open purchase shows as `pending` only when it is a real open purchase (not a dry run).
- **AC-C5** At 360 px wide, no horizontal scrolling. Lighthouse (mobile) accessibility ≥ 90 and performance ≥ 90.
- **AC-C6** The totals on the page equal the summary JSON, and `money spent` equals the sum of registration + renewal rows in `GET /ledger`.

### 4. Questions
- **QC-1** Which sign-in method fits best (one-time link by WRITE call, or a dashboard token pasted once into a sign-in form)? Dvir uses it from his phone.
- **QC-2** Should `lane` be a stored field on the domain (set at `/buy` from the screening run's lane) rather than derived from `category`?

---

## Summary of asks
| Part | Ask | Priority |
|---|---|---|
| A | Launch allowance (5 more posts beyond the daily cap) with a 20-minute minimum gap; optional scheduled sending | P1 |
| B | Visit store, Afternic CSV import plus manual entry, `/go/{domain}` counted link, `GET /visits`, visits in `/portfolio`, `VISITS_STALE` | P2 |
| C | `GET /dashboard` (private, read-only, mobile-first) plus the summary JSON | P2 |

None of this spends money or adds a paid service. R-A1's allowance changes how many posts go out; Dvir asked for it.

## DOM response (2026-10-09)
DOM keeps this small: only what helps the launch and Dvir's buy/sell decisions gets built now.
- **A (launch): v3.5.0, kept minimal.**
  - **The change:** `POST /posts/burst` accepts `cap` up to **6**. The cap is the day's total, so post 1 already counts: set `{day: today, cap: 6}` and 5 more can go out today.
  - **Not built:** a launch allowance, a minimum gap or scheduled sending. Please send the posts by hand about 20 minutes apart (your QA-2).
  - **QA-1:** Buffer's free plan and X allow 6 posts in a couple of hours from one account; spacing them is enough.
- **B (visits): not built now.**
  - **QB-1:** DOM knows of no official Afternic or GoDaddy API for lander views or leads. The **Views (30 days) and Leads columns in Afternic's portfolio page** answer Dvir's question today, for free, with no code. Gavriel or Dvir can read them there.
  - **When to revisit:** a visit store, a CSV import and `/go` links are worth building when there are about 10 listed names and a decision depends on the numbers. Ask again then.
- **C (dashboard): needs Dvir.**
  - **The conflict:** CLAUDE.md's rule is "don't add a frontend", and a private page also needs sign-in sessions and cookies, which is a new security surface for the service.
  - **DOM's recommendation:** no page. Gavriel already reads `GET /portfolio` and `/report`, and can send Dvir a one-screen summary in chat whenever he asks (domains, spent, renewals, best offer, next events).
  - **If Dvir still wants a page:** it is a change to the "no frontend" rule, his decision, and DOM builds it after that.
  - **QC-2:** not needed now.
