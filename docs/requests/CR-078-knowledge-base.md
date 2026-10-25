# CR-078: knowledge base module (DOM, requested by Dvir, 25 Oct 2026)

**Status:** approved by Dvir (25 Oct 2026: "We need to build a knowledge base module that will be able to digest a lot of data, to rate quality of each data source and to be able to consider decisions with all the data we found so far and not from a random post"; "Yes let's fix and improve all 8"). Gap G-132. Design research: `docs/research/knowledge-sources-2026-10.md` (49 graded sources; §2.2-2.5 are the binding design inputs).

**Gavriel:** Dvir wants your own knowledge base migrated here (`DOM-TO-GAVRIEL.md`, 25 Oct). Your reply about what you hold shapes the import route (phase 1).

## Business need
Decisions about what to buy, at what price, and how to sell must rest on the weight of all the evidence we have collected, graded, with echoes removed. Never on one post. Today research lives in markdown files that nothing can weigh or recompute.

## Rules (binding)
1. **No AI in the server** (founder rule 9). The server stores, deduplicates and computes, in plain code. Research sessions (DOM) and the bots read, extract and grade.
2. **Free sources only; legal access only.**
   - RSS feeds, official free APIs, and pages that load without a challenge.
   - Never: marketplaces, bot-protection bypass or proxies, Wayback automation, NameBio beyond its free endpoints, Reddit (commercial use needs an agreement; its API closes to new users on 31 Oct 2026), X (no free reads).
3. **Two grading axes:**
   - the source's reliability, A/B/C/D/F (F = not yet judged, weight 0);
   - the item's credibility, 1-5, judged on its own.
   - Grades apply per claim type (a marketplace is A for its own sales count, D for "now is a great time to buy").
4. **Independence:** echoes, syndications and aggregators form one cluster with their original. Only the strongest item of a cluster counts.
5. **The weights live in a versioned settings row** (like `pricing_settings`), changed by migration or admin command only, never hard-coded:
   - grade, credibility, sample size, age (half-life per topic) and kind.
   - The formula is in research §2.3 C.
6. **Verdicts are appended, never edited.**
   - Each one carries its certainty (high / moderate / low / very low, GRADE-style, §2.3 D), the reasons for each step down in plain words, the clusters used and a snapshot of the inputs.
   - Any verdict above very low needs at least 3 independent clusters, 2 of them A or B.
7. **Append-only evidence:** sources, claims, evidence and links are append-only (`reject_mutation`). A correction is a new row that supersedes the old one.
8. **Every write route takes arrays** (bulk, up to 1,000 rows), is idempotent and audited. The audit keeps row counts.
9. **DOM never posts to production** (HARD RULE). DOM's own research reaches the base as repo files: `data/knowledge/*.jsonl` in the same format as the routes. A step of the daily job loads new files, so a release ships knowledge like code. The load is idempotent by file hash and row key.

## Phase 1 (one release)
- **Tables:** `kb_settings` (versioned), `kb_authors`, `kb_sources`, `kb_claims`, `kb_evidence`, `kb_source_links`, `kb_questions`, `kb_verdicts` (fields as in research §2.2).
- **Write routes** (WRITE, bots, data scope; arrays): `POST /kb/sources`, `/kb/authors`, `/kb/claims`, `/kb/evidence`, `/kb/links`, `/kb/questions`.
- **Read routes:**
  - `GET /kb/questions`, `GET /kb/questions/{id}/verdict` (computed on read and appended when it changed: verdict, certainty, downgrades, top clusters with URLs);
  - `GET /kb/claims?topic=`;
  - `GET /kb/sources?status=lead|graded&topic=`;
  - `GET /kb/recheck` (claims whose age weight has fallen below 0.5).
- **Echo flags:**
  - the same canonical URL;
  - MinHash similarity of the stored excerpt ≥ 0.5 (word 5-gram shingles, plain code), flagged for a session to confirm.
- **Repo load:** daily step `kbLoad` reads `data/knowledge/*.jsonl`.
  - The first files hold the roughly 130 graded sources of the October research files, plus their claims. DOM extracts them in a research session after the release, keeping their grades.
- **Size:** text is short (excerpt ≤ 300 characters, quote ≤ 15 words). About 1,000 sources and 5,000 evidence rows is well under 10 MB.

## Phase 2
- **Daily lead collector `kbLeads`:** the 12 RSS feeds verified in research §1.1, and the Hacker News Algolia API.
  - Once a day, one request per feed, `robots.txt` honoured, with an honest User-Agent.
  - It stores only metadata (URL, title, author, date, a 300-character excerpt) as `lead` sources. No AI.
- **YouTube Data API metadata:** only once Dvir creates a free key himself (`YOUTUBE_API_KEY` in `prod.env`). Raw API data is deleted after 30 days, as its terms require; claims and links stay.
- **Author track scores:** after 6 months of outcomes (research §2.3 E).

## Not doing
Paid sources; Reddit; X; scraping forums behind a challenge (NamePros threads); AI summarising inside the server.

## Acceptance
- A verdict for a test question with fixtures:
  - 3 independent A/B clusters that agree → moderate or high;
  - the same evidence posted as 5 echoes of one post → still 1 cluster, and very low;
  - D-grade sources only → weight 0.
- Re-posting the same file is a no-op; the same `Idempotency-Key` returns the stored answer.
- No route or job calls an AI model (a test greps the module).
- The `kbLoad` step loads a fixture file once and skips it the second time.
