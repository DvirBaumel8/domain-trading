# External sources: terms log (CR-001 P-3, ground rule 6)

Rule: a source is used only after its terms are quoted here (verbatim, with URL and retrieval date) **and** its `sources.<name>` flag is true in the active selection settings. If the terms could not be verified from the primary source the entry says **UNVERIFIED**, the decision is `disabled`, and no data from that source is committed or fetched. All entries retrieved by DOM on **2026-10-06** with `curl` (honest User-Agent `domain-trading-api/2.0.0 (+https://github.com/DvirBaumel8/domain-trading)`) unless noted. Everything here is read-only toward the outside world; nothing is posted, nothing contacts a person.

Summary

| Source | Check | Decision | Pacing |
|---|---|---|---|
| SCOWL / ESDB word list | CAP-01 dictionary | enabled (committed) | n/a (file) |
| US Census Gazetteer places | CAP-01 city list | enabled (committed) | n/a (file) |
| Majestic Million | CAP-02 TYPO-1 | **enabled** (CC BY 3.0; replaces Tranco) | 1 download per day, first N rows only |
| Tranco | CAP-02 TYPO-1 | **not used** (no licence of its own, CC BY-NC upstream) | none |
| SURBL `multi` | CAP-05 | enabled | <= 5 queries/s, control lookup per batch |
| NameBio | CAP-11 | **disabled, UNVERIFIED** | none |
| Internet Archive CDX | CAP-07 | **disabled pending written permission** (terms: "scholarship and research purposes only"; Dvir 6 Oct) | <= 1 request/s |
| IANA RDAP bootstrap | CAP-03 | enabled | 1 fetch per day |
| Verisign RDAP (.com, .net) | CAP-03 | enabled | <= 1 query/s, back off on 429 |
| PIR RDAP (.org) | CAP-03 | enabled | <= 1 query/s |
| Identity Digital RDAP (.info, .ai) | CAP-03 | enabled | <= 1 query/s |
| .co, .io, .us RDAP | CAP-03, CAP-12 | **disabled: no base in the IANA bootstrap** | none |
| Google Web Risk Lookup API (`uris:search`) | CAP-06, `portfolioCheck` blocklist | **enabled when `GOOGLE_WEB_RISK_API_KEY` is set** (2.3.0; key in the `x-goog-api-key` header, never the URL). Update API never called (pricing switch; static test) | DOM cap 10,000 per UTC month (`WEB_RISK_MONTHLY_CAP`, table `api_usage`); Google free tier 100,000 |
| Our own domains, `http://<domain>/` | `portfolioCheck` web answer | enabled (our names, served by the lander) | 1 request per listed name per day, via `safeFetch`, redirects not followed |
| USPTO TSDR (`USPTO_API_KEY`) | CAP-08 | **not used**: status by serial number only, no wordmark search (CR-007 Q-8); TM-1 stays manual | none |
| CZDS `.com` zone | CR-007 G-2 B | **not used**: not possible at $0 (CR-007 §19.2) | none |
| Business websites (operator and firm home pages) | CAP-12, CAP-15 | **enabled** (`sources.business_sites`; robots.txt honoured) | <= 1 request per `same_name.min_ms_between_fetches` ms (default 1 s); CAP-15 per `lead.verify.min_ms_between_fetches` |

---

## SCOWL / English Speller Database (ESDB)
- **URLs used:** `http://app.aspell.net/create?max_size=60&spelling=US&max_variant=0&diacritic=strip&download=wordlist&encoding=utf-8&format=inline` (generated list; ESDB git revision 1e5b7d3, 24 Jun 2026); licence `https://raw.githubusercontent.com/en-wl/wordlist/v2/Copyright`; project page `https://wordlist.aspell.net`.
- **Purpose:** CAP-01 dictionary tokens (`data/wordlists/en-scowl-60.txt`).
- **Terms URL:** `https://raw.githubusercontent.com/en-wl/wordlist/v2/Copyright` (also repeated in the header of every generated list).
- **Quote (permission):** "Permission to use, copy, modify, distribute, and sell any part of the English Speller Database (ESDB, previously known as SCOWLv2), or word lists created from it, is hereby granted without fee, provided that the above copyright notice appears in all copies and that both the above copyright notice and this notice appear in supporting documentation."
- **Quote (limit):** "Kevin Atkinson makes no representations about the suitability of this database for any purpose. It is provided \"as is\" without express or implied warranty." Condition: keep the notice with the data (`data/wordlists/LICENSE-SCOWL.txt`).
- **Decision:** `enabled`. **Pacing:** none (committed file, rebuilt only by `scripts/build-wordlists.ts`).

## US Census Bureau Gazetteer, National Places file
- **URL used:** `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_place_national.zip` (linked from `https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html`).
- **Purpose:** CAP-01 city and state list (`data/wordlists/us-places.txt`).
- **Terms:** the files carry no licence text of their own and the Census page states none. The file is a US Government work: 17 U.S.C. section 105, `https://www.law.cornell.edu/uscode/text/17/105`.
- **Quote:** "Copyright protection under this title is not available for any work of the United States Government, but the United States Government is not precluded from receiving and holding copyrights transferred to it by assignment, bequest, or otherwise."
- **Limit:** none found for the Gazetteer files. (The Census API Terms of Service, `https://www.census.gov/data/developers/about/terms-of-service.html`, apply to the Data API only and require the notice "This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau."; we do not use the API.) We do not imply Census endorsement.
- **Decision:** `enabled`. **Pacing:** none (committed file).

## Majestic Million (the popularity list for TYPO-1; replaces Tranco)
- **URL used:** `https://downloads.majestic.com/majestic_million.csv` (`HTTP/2 200`, `content-type: text/csv`, `last-modified: Tue, 06 Oct 2026 05:00:21 GMT`, 81,323,114 bytes, `accept-ranges: bytes`; columns `GlobalRank,TldRank,Domain,TLD,RefSubNets,RefIPs,IDN_Domain,IDN_TLD,PrevGlobalRank,PrevTldRank,PrevRefSubNets,PrevRefIPs`, sorted by rank). Retrieved 2026-10-06 with `curl`.
- **Purpose:** CAP-02 TYPO-1 popularity list (`src/screening/popularity.ts`, `src/screening/checks/typo.ts`); the settings switch is `sources.popularity`.
- **Terms URL:** `https://majestic.com/reports/majestic-million` (the report page, "Export CSV (~80MB)" block).
- **Quote (licence, verified at the primary source 2026-10-06):** "Licensed under a Creative Commons Attribution 3.0 Unported License". The same wording is repeated by Tranco's own attribution text for its Majestic input: "Majestic (available under a CC BY 3.0 license)".
- **Why not Tranco:** Tranco has no licence of its own (`/terms` is 404) and one of its inputs is CC BY-NC 4.0 (Cloudflare Radar); a non-commercial upstream is not acceptable for a commercial trading business (gap G-30, resolved).
- **Conditions:** CC BY 3.0 allows commercial use with attribution: "Majestic Million, Majestic (https://majestic.com), CC BY 3.0" (kept in `selection.md`). We store only the first `typo.top_n` rows as `rank,domain` text in `reference_files` (name `popularity_list`), use them as an internal lookup, and do not redistribute them. The test fixture `tests/fixtures/screening/majestic-million-top.csv` is the first 1,000 rows (about 71 KB) with the same attribution.
- **Fetch:** one GET per day from the `referenceRefresh` job step (never in a request or a run), streamed and cancelled after `typo.top_n + 1` lines so the 81 MB file is not downloaded; honest User-Agent; a non-200, empty or non-CSV answer keeps the previous snapshot and fails the step.
- **Decision:** `enabled`. **Pacing:** one download per day (a refresh inside 20 hours is skipped).

### Tranco (not used)
- **URLs seen (Task 1):** `https://tranco-list.eu/api/lists/date/latest`, `https://tranco-list.eu/download/<list_id>/<N>`; no licence or terms for the list itself; the home page lists upstream providers including "Cloudflare Radar ( available under a CC BY-NC 4.0 license)". Not fetched by the service.

## SURBL (`multi.surbl.org`)
- **URLs used:** DNS A queries `<domain>.multi.surbl.org` against the public name servers of the zone (`a.surbl.org` ... `j.surbl.org`, from `dig NS multi.surbl.org`); `https://www.surbl.org/usage-policy`, `https://www.surbl.org/lists`, `https://www.surbl.org/guidelines`.
- **Purpose:** CAP-05 spam/abuse blocklist (Task 5).
- **Terms URL:** `https://www.surbl.org/usage-policy` (version 2.01, 05/10/2024).
- **Quote (permission):** "Our intelligence datasets are updated more than 240 times daily and are provided to users worldwide via public DNS servers or via a data feed service. The former (DNS query) is completely free and subject to certain usage restrictions" and "For individual users, small charitable or non-profit organizations, small businesses or any other organizations that have fewer than 1,000 users or that scan fewer than 250,000 messages per day in total, the Free Query Service (FQS) is completely free and can be accessed via a worldwide network of servers."
- **Quote (limit):** "Free use of FQS is restricted and does not include embedding our data in any way into products or services for which a fee is charged." We query per candidate name for our own buy decisions and do not resell or embed the data. Also: "If you get a result of 127.0.0.1 when doing a DNS query into the public nameservers, then it means your access is blocked." (`/lists`): treat 127.0.0.1 as `QUERY_REFUSED` (UNKNOWN), never as listed or clean.
- **Return bits (`/lists`):** the last octet of the A record is a bitmask: "4 = listed on DM", "8 = listed on PH", "16 = listed on MW", "32 = listed on CT", "64 = listed on ABUSE", "128 = listed on CR"; "127.0.0.80 means a record is on both MW and ABUSE (comes from: 16 + 64 = 80)". "Octets other than the first and last one are reserved for future use and should be ignored." Automatic processing "be based on the A record only" (TXT is for humans).
- **Test point:** `test.surbl.org` is listed ("2.0.0.127 and test.surbl.org and similar ... appear in our lists", `/guidelines`). Verified 2026-10-06: `dig +short test.surbl.org.multi.surbl.org @a.surbl.org` returns `127.0.0.254`; `example.com.multi.surbl.org` returns NXDOMAIN. Control lookup = `test.surbl.org.multi.surbl.org` must answer `127.0.0.x` listed. Guideline: responses must be in 127/8, otherwise the resolver is rewriting answers (`SOURCE_ERROR`).
- **Server discovery (checked live 2026-10-06):** `multi.surbl.org` has no NS records of its own (a query for them answers SERVFAIL/no data); the NS of `surbl.org` (`green`, `blue`, `purple`) answer the control name with no data. The query hosts are `a.surbl.org` ... `j.surbl.org` (A records; each answered `test.surbl.org.multi.surbl.org` with `127.0.0.254`, `example.com.multi.surbl.org` with NXDOMAIN). The check tries `surbl.ns_override`, then the zone's NS, then `a`..`j` of the parent domain, and uses the first group that answers the control as listed.
- **Recorder output (2026-10-06, untrimmed IANA bootstrap):** `netextend.co  no RDAP base in the IANA bootstrap: nothing recorded`, `netextend.io  no RDAP base ...`, `netextend.us  no RDAP base ...` (the recorder checks the full, untrimmed file; `net`, `org`, `ai`, `info` each had a base and were recorded).
- **Direct queries:** the policy speaks of "public DNS servers"; it does not forbid querying the zone's authoritative servers directly and names no numeric limit. We treat that as allowed at low volume. Public recursive resolvers may be refused (DR-001); use the zone servers.
- **Decision:** `enabled`. **Pacing:** <= 5 queries/s in total, rotate over the ten servers, one control lookup per batch, no repeat lookups inside the cache window.

## NameBio
- **URLs tried:** `https://namebio.com/`, `/terms`, `/terms-of-service`, `/tos`, `/help`, `/faq`, `/api`, `/data`, `/downloads` (all 2026-10-06, also with the honest User-Agent); `https://archive.org/wayback/available?url=namebio.com/terms` (no snapshot).
- **Result:** every request answers **HTTP 403** with a Cloudflare "Sorry, you have been blocked" page (Ray ID a4627f965f3cc222); the terms of use, the free CSV download URL, the "1 download per hour" limit, attribution wording and storage rights could **not** be read from the primary source. DOM does not spoof a browser to get around the block.
- **Status:** **UNVERIFIED.** No terms quote, no URL, no limit known; the "1 download per hour" figure in CR-001 is hearsay.
- **Task 6:** only a disabled stub exists (`src/screening/namebio.ts`: the parser, a cache reader and a `refreshNameBio` that never makes a request). The test sample `tests/fixtures/screening/namebio/retailstats-sample.csv` is **synthetic** with a placeholder header (`keyword,start_count,end_count,exact_count[,avg_price_usd]`); the real header is unknown. Attribution text: `Data from NameBio`.
- **Decision:** `disabled`. No NameBio data is fetched or committed; `sources.namebio` defaults to `false` (Task 3); CAP-11 returns `UNKNOWN` / `SOURCE_DISABLED`; the manual path (CR-001 CAP-11 fallback) stays. Logged as a gap for Dvir (`docs/internal/gaps.md`, G-29).
- **Pacing:** none.

## Internet Archive Wayback CDX server
- **URLs used:** `https://web.archive.org/cdx/search/cdx?...` (documented at `https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md`, "Wayback CDX Server API - BETA").
- **Purpose:** CAP-07 HIST-2 capture history (Task 7). Built in Task 7: the CDX index (`matchType=domain&collapse=digest&limit=2000&fl=timestamp,original,statuscode,mimetype,digest[&to=]`) and the archive's raw-capture URLs `https://web.archive.org/web/<timestamp>id_/<original>` (documented in the Wayback URL scheme: `id_` returns the archived bytes without the toolbar), fetched without following redirects. Fixtures: `tests/fixtures/screening/wayback/` (recorded 2026-10-06 by `npm run record:screening -- wayback <domains>`, CDX trimmed to 200 rows and capture bodies to 64 KB; the `synthetic-*.json` files are hand-made).
- **Terms URL:** `https://archive.org/about/terms.php`. The page is rendered by JavaScript: `curl` returns an empty shell (1,872 bytes) and `web.archive.org/web/2025/...` returns no text, so **the Terms of Use text is UNVERIFIED** (DVIR).
- **Quote (documented API):** "The `wayback-cdx-server` is a standalone HTTP servlet that serves the index that the `wayback` machine uses to lookup captures." "The CDX server is deployed as part of web.archive.org Wayback Machine and the usage below reference this deployment." "The cdx server is designed to improve access to archived data to a broad audience, but it may be necessary to restrict certain parts of the cdx." No numeric rate limit and no "be polite" paragraph is documented in the README; the API can answer HTTP 429 or time out.
- **Terms (retrieved 2026-10-06 from the Archive's own capture of its terms page):** `https://web.archive.org/web/20240602013902id_/https://archive.org/about/terms.php`: "Access to the Archive's Collections is provided at no cost to you and is granted for scholarship and research purposes only." Dvir cites the 2021 capture of the same page as saying the same; DOM could not re-fetch it on 2026-10-06 (the Archive answered "Temporarily Offline"), so only the 2024 quote is verified by DOM here. The live terms page itself is JavaScript-only.
- **Decision (Dvir, 6 Oct 2026; CR-002 Amendment B1): DISABLED permanently; no permission request is pending.** `sources.wayback` is `false` in the seed; the history check answers MANUAL_REQUIRED `MANUAL_SOURCE` and nothing is fetched. HIST-2 is recorded by hand (`POST /screening/runs/{id}/manual`, `check: "history"`). The automated code stays built and tested with the source switched on, but is not planned for use; it would need a written yes from the Archive and a settings draft + activation with Dvir's approval.
- **Design if enabled:** a documented public API; read-only. **Pacing:** <= 1 request/s per host through one pacer (`history.min_ms_between_calls`, default 1000; the index and the captures share web.archive.org), `limit` and `fl` always set, `collapse` used, honest User-Agent, back off on 429/5xx, `UNKNOWN` on any non-conforming body (never "no history").

## IANA RDAP bootstrap
- **URL used:** `https://data.iana.org/rdap/dns.json` (publication 2026-09-30T23:00:03Z, version 1.0, 71,334 bytes).
- **Purpose:** CAP-03 map a TLD to its RDAP base.
- **Terms URL:** `https://www.iana.org/help/licensing-terms`.
- **Quote:** "IANA and IETF intend that the Protocol Registries may be freely used by any party for any purpose." (the page continues with a CC0 1.0 dedication).
- **Limit:** none stated. **Decision:** `enabled`. **Pacing:** one fetch per day (cache in `reference_files`).
- **Content checked 2026-10-06:** `com` -> `https://rdap.verisign.com/com/v1/`; `net` -> `https://rdap.verisign.com/net/v1/`; `org` -> `https://rdap.publicinterestregistry.org/rdap/`; `info` and `ai` -> `https://rdap.identitydigital.services/rdap/`. **`co`, `io` and `us` have no entry in the bootstrap.**

## Verisign RDAP (.com, .net)
- **URLs used:** `https://rdap.verisign.com/com/v1/domain/<name>`, `/net/v1/...`; terms `https://www.verisign.com/domain-names/registration-data-access-protocol/terms-service/index.xhtml` (linked from `https://rdap.verisign.com/com/v1/help` as `rel: terms-of-service`).
- **Purpose:** CAP-03 availability (404 = not found = available), CAP-10 sibling registered-share, CAP-12 extension dates.
- **Quote (permission and limits):** "TERMS OF USE: The data in Verisign's RDAP database is provided by Verisign for information purposes only, and to assist persons in obtaining information about, or related to, a domain name registration record. ... By submitting a RDAP query, you agree to use the data in Verisign's RDAP database only for lawful purposes and that under no circumstances will you use the data to: (1) allow, enable, or otherwise support the transmission of mass unsolicited, commercial advertising or solicitations via e-mail, telephone, or facsimile; or (2) enable high volume, automated, electronic processes that send queries or data to the systems of Verisign or an ICANN-accredited registrar, except as reasonably necessary to register domain names or modify existing registrations. Verisign reserves the right to restrict your access to the RDAP database in its sole discretion to ensure operational stability."
- **Published rate limit:** none numeric. **Decision:** `enabled` (low volume, a screening batch is not "high volume"; we never contact anyone). **Pacing:** <= 1 query/s per host, a batch capped by `batch.max_names`, honour HTTP 429 / `Retry-After`, cache results (`rdap_lookups`).

## Public Interest Registry RDAP (.org)
- **URL used:** `https://rdap.publicinterestregistry.org/rdap/domain/<name>`; terms in the `notices` of `.../rdap/help` (link `https://thenew.org/org-people/about-pir/policies/`).
- **Quote:** "Users accessing the Public Interest Registry RDAP service agree to use the data only for lawful purposes, and under no circumstances may this data be used to: a) allow, enable, or otherwise support the transmission by e-mail, telephone, or facsimile of mass unsolicited, commercial advertising or solicitations to entities other than the registrar's own existing customers and b) enable high volume, automated, electronic processes that send queries or data to the systems of Public Interest Registry or any ICANN-accredited registrar, except as reasonably necessary to register domain names or modify existing registrations." and "Queries to the RDAP services are throttled. If too many queries are received from a single IP address within a specified time, the service will begin to reject further queries for a period of time to prevent disruption of RDAP service access."
- **Published rate limit:** none numeric. **Decision:** `enabled`. **Pacing:** as Verisign.

## Identity Digital RDAP (.info, .ai)
- **URL used:** `https://rdap.identitydigital.services/rdap/domain/<name>` (an unregistered name answers 404); terms in the `notices` of `.../rdap/help` (link `https://www.identity.digital/policies/rdds-access-policy`).
- **Quote:** "This service is intended only for query-based access. You agree that you will use this data only for lawful purposes and that, under no circumstances will you use this data to (a) allow, enable, or otherwise support the transmission by e-mail, telephone, or facsimile of mass unsolicited, commercial advertising or solicitations to entities other than the data recipient's own existing customers; or (b) enable high volume, automated, electronic processes that send queries or data to the systems of Identity Digital, a Registrar, or Registry Operator except as reasonably necessary to register domain names or modify existing registrations." and "Queries to the RDAP services are throttled."
- **Published rate limit:** none numeric. **Decision:** `enabled`. **Pacing:** as Verisign.

## .co, .io, .us RDAP
- **Result:** the IANA bootstrap (2026-09-30) lists no RDAP base for `co`, `io` or `us`. DOM does not guess a base URL or scrape web WHOIS.
- **Decision:** `disabled`. CAP-03 / CAP-12 for those extensions return `UNKNOWN` / `NO_REGISTRY_SERVICE` (never "available", never "not registered"). A base can be added later by a settings/list change once it appears in the bootstrap or a primary source is quoted here.

## Business websites (CAP-12 operator sites, CAP-15 firm pages)
- **What is fetched:** the public home page of a site that uses our name on another extension (CAP-12: `https://<sld>.<tld>/`), and, for lead verification (CAP-15), the firm pages the bot supplied. Nothing else: no crawling, no links followed, no search engines, no social networks.
- **Purpose:** CAP-12 asks whether our exact name is already in use as a business name or a service description under another extension (`src/screening/site.ts`, `src/screening/checks/same-name.ts`); CAP-15 checks that a lead firm really offers the service the name describes.
- **Policy (how DOM fetches third-party sites):**
  - one `GET /robots.txt` per origin and run (or batch), read before any page; honoured for the group `User-agent: domain-trading-api` and, when there is no such group, for `User-agent: *`; the longest matching `Allow`/`Disallow` wins, `Allow` on a tie; a missing robots file (404, 410, other 4xx) allows everything, but a robots file that cannot be read (timeout, 5xx, 429, TLS or network error) means the page is **not** fetched and the result is UNKNOWN (never "no site");
  - GET only, for the pages needed (CAP-12: the home page; CAP-15: the bot-supplied URLs), at most **one request per `same_name.min_ms_between_fetches` / `lead.verify.min_ms_between_fetches` milliseconds** (default 1,000) through one pacer for the whole run, redirects followed by hand (at most `same_name.max_redirects`, each one paced, robots checked for each new host; a redirect to another site is recorded and **not** followed), `same_name.timeout_ms` per request and `same_name.max_bytes` per body;
  - the honest `USER_AGENT` of `src/rdap.ts` (`domain-trading-api/<version> (+https://github.com/DvirBaumel8/domain-trading)`); no browser spoofing;
  - **no login, no form submission, no CAPTCHA solving, no script execution.** A page behind a login wall, a challenge page or a bot block (HTTP 401 / 403) is UNKNOWN, never read as "no site";
  - **never `linkedin.com`** (and no host in `lead.verify.never_fetch_hosts`, subdomains included; the settings reject a draft that drops `linkedin.com`). This is enforced in the one outbound guard `src/net/safe-fetch.ts`, for the start host and for every redirect host (`HOST_EXCLUDED`);
  - **outbound guard (SSRF):** every request goes through `safeFetch`: http/https only, default ports only, no IP-literal hosts; DOM resolves the host itself and refuses private, loopback, link-local, CGNAT, multicast, reserved and documentation addresses and IPv6 forms embedding them (`ADDRESS_BLOCKED`); the connection is made to the vetted address only (undici's own `fetch` with an undici Agent whose lookup returns it; redirects are always manual; the DNS lookup has a timeout), so a second DNS answer cannot redirect it. robots.txt redirects must stay on the same host;
  - a fetch that fails for any reason except a clear "no site there" (DNS name does not exist, connection refused, 404-style answer) is UNKNOWN; the check then FLAGs `SITE_UNKNOWN` for a human and never PASSes.
- **Stored:** URL, retrieval time, sha256 of the response, and the visible text (capped at `evidence.max_text_bytes`, gzipped) **only for CAP-12 operator pages**. For firm pages (CAP-15) only the hash and URL are kept, because they hold personal data. The raw HTML is never stored.
- **Terms:** there are no single terms of use (every owner differs). DOM relies on robots.txt and on the page being published for the public. A site owner who objects is honoured by adding the host to `lead.verify.never_fetch_hosts` through a settings version, or by their own robots.txt.
- **Decision:** `enabled` (`sources.business_sites` true in the seed and in `DEFAULT_SELECTION_VALUES`). **Pacing:** <= 1 request per second (one pacer for the run), one robots.txt per origin.
