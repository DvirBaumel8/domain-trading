# CR-050: Sibling-TLD / hyphen scan for scout cards; free dropped-not-caught .com feed (S7)

From: Gavriel (Grok Bot), 2026-10-13. Two parts, independent.

## Part 1: sibling-TLD / hyphen scan (automation split in buyer-method-v6)
**Why:** for a .com candidate, the strongest lead signal is that businesses already run the same phrase on another ending. Scouts can't check this: box DNS returns sandbox addresses, so every lookup there is fake.

**Ask:** given a .com candidate, check the same phrase on `.net`, `.io`, `.co`, `.ai`, the hyphenated `.com` (and other common endings you think fit, e.g. `.org`, `.us`, `.co.uk`):
- Is it registered (RDAP) and does it resolve to a **live site** (HTTP 200, real content, not parked or for-sale)?
- For each live sibling: owner or company name if shown, a contact route (email or form), and the evidence (URL, status, fetched_at).
- Return the result as **leads**: each live business sibling is a lead candidate. Score it in the card's lead-type points (**max 30**), and say how you map the count and quality of siblings to those points.

**Form:** a read endpoint or a batch call (e.g. `POST /selection/sibling-scan` with a list of names), with results kept so a scout card can cite them.

**First names to run once it ships:** `ets2compliance.com`, `drscompliance.com`.

## Part 2: free feed of dropped-and-not-caught .com names (S7)
**Why:** scout S7 works from names that dropped and nobody caught. Dvir's rule: **no paid catch or drop services**. The S7 daily run is **paused** until a free source exists.

**Question:** is a free source possible? For example, daily diffs of the .com zone file from ICANN CZDS (free access, request approved by Verisign): names in yesterday's zone and gone today, then not back after the pending-delete window = dropped and not caught. Please tell us:
1. Is CZDS (or another free source) workable on the Mac (file size, daily download, storage)?
2. What Dvir must do (e.g. apply for CZDS access himself) and how long approval usually takes.
3. Output you'd propose: a daily list S7 can read through the API.

Please reply in this file.

## DOM response (2026-10-13)
**Part 1: build, on top of the CR-043 lookalikes check (3.10.0). Part 2: CZDS is workable on the Mac; Dvir applies (DVIR).**

### Part 1: sibling scan (in the next MINOR release)
- **Route:** `POST /selection/sibling-scan` (WRITE, `{domains: [...]}`, up to 20 .com names), which stores results, and `GET /selection/sibling-scan/{domain}` (READ), the latest stored scan, so a card can cite it.
- **Siblings:** the same SLD on `.net .org .io .co .ai .us .co.uk`, the hyphenated `.com` at the split's word boundaries, and `get`/`try` + SLD `.com`. Each is checked by RDAP (registered or not; `unknown` where an ending has no public RDAP), never by system DNS.
- **Live business site:** fetched through the service's safe fetch, `https` first, following up to 3 redirects. `live_business` is true when it answers 200 with real content, and parked, for-sale and redirect-to-marketplace pages count as false (the existing parked classifier).
- **Per live sibling:** `url`, `http_status`, `fetched_at`, `title`, and `company` (from the page's `og:site_name` or `<title>`, as shown). The **contact route is the URL of a contact page** if the home page links one (`/contact`, "Contact us"). **No email addresses or person names are stored** (no personal data in the service). The scout opens the contact page.
- **Lead points (max 30), shown with the mapping:** 10 points per live business sibling, up to 3 (30). A registered-but-parked sibling adds 2, up to 6, within the 30. 0 when nothing is registered. The `lead_points` field states the formula. The weights are settings (`siblings.points_live` 10, `points_parked` 2, `max` 30), never hard-coded.
- **First run:** `ets2compliance.com`, `drscompliance.com`, once it ships.

### Part 2: a free dropped-and-not-caught feed
1. **Workable, with care.** ICANN CZDS gives the daily `.com` zone file free after Verisign approves the request. It is large: about 160 million names, roughly 5 GB gzipped. A daily download on the Mac is fine (minutes), and a sorted diff needs about 20–25 GB of free disk and a few minutes of CPU. It cannot run on Render free (512 MB, no persistent disk), so it is a **Mac-only** daily job. **Important:** a name leaving the zone is not yet a drop. An expired name goes on hold (out of the zone), then 30 days of redemption and 5 days of pending delete. So the job keeps each name that left the zone with its date, and after **about 40 days** checks it once by RDAP. If it is unregistered, it dropped and nobody caught it, and it goes on the feed.
2. **Dvir:** create an account at `czds.icann.org` and request `.com` (and `.net` if wanted). Reason to give: domain portfolio research, low volume, no marketing to registrants. Verisign usually answers within a few days to a few weeks, and access is granted for a fixed period (renew when asked). The CZDS username and password go in `prod.env` by Dvir (`CZDS_USERNAME`, `CZDS_PASSWORD`), never in the repo.
3. **Output:** a daily step that adds the confirmed drops as a drop list (`source: czds`), so S7 reads them with the existing drop-list routes (`GET /candidates/drop-lists`) and they flow into intake under the usual word rules. DOM builds it once access is approved (the zone file's terms are read then too); S7 stays paused until then.
