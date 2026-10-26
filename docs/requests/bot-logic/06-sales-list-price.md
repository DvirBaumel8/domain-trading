# Sales: list + price path (current)

**Status:** current SOP only (awareness-gap close for Dvir). Draft for Gavriel, 2026-10-27 ~01:55 Asia/Jerusalem.  
**Owner:** Sales (Sochen / Head of Sales; absorbs CFO ledger).  
**Money actions:** Gavriel only, each with Dvir's explicit yes. Sales drafts plans and records; never changes prices, listings, or sends outreach alone.  
**Build freeze:** document the path as practiced; do not invent new process.

**Primary sources:** `sales/playbook.md` (Day 0 §3, pricing §5.0, channels §3), `sales/offers.md`, `sales/listings-evidence-2026-10-21.md`, `sales/sell-chance-2026-10-20.md`, `ledger/portfolio.csv`, `org/org-v2.md`, `company/decisions-log.md` (D-2026-10-13-01, D-2026-10-20-D005-PRICE, BUG-049), `deals/D-001-promptinjectionaudit/listing.md`, `knowledge/evidence-ledger.md` B-07, `knowledge/handoffs/cfo.md`.

This file is **current-only**. It does not propose LTO, NS moves, Fast Transfer opt-in, or outreach restarts.

---

## 1. Afternic / Sedo step order after a buy

Gates (playbook): **A** = buy, **B** = listing/price. On a normal buy card, **A+B are one Dvir approval**; the card stores the sell plan (BIN / floor / walk-away / min / LTO / schedule). Manual buys (e.g. D-001) use `import-domain` then a separate list path once approved.

Order below is the Day-0 sequence in `sales/playbook.md`. Who does the click is marked. **No step below is permission to list without Dvir's Gate B yes.**

| # | Step | Who | Done when |
|---|---|---|---|
| 0.1 | Buy / import: `POST /buy` (or admin `import-domain`) with category, proposed listing, screening pack / pricing evidence, settings version. Ledger gets a `registration` / buy row; portfolio row created. Record **RDAP creation time**, not order time. | Gavriel → DOM/API (manual buy: Dvir pays, then import) | Domain in our registrar account; `ledger/ledger.csv` + `ledger/portfolio.csv` row |
| 0.2 | Auto-renew **OFF**, WHOIS privacy **ON** | API (Porkbun) / Dvir (GoDaddy) | Screenshot → `deals/D-NNN/evidence/`; portfolio flags match |
| 0.3 | **Sedo (optional, only if Sedo will be used):** add Sedo ownership TXT at **registrar DNS**, add name on Sedo, wait until Sedo shows verified. Skip if this would delay 0.4 by > ~30 min. | Dvir | Sedo dashboard "verified" (or equivalent; Sedo UX varies). **Current portfolio:** D-002/D-003 submitted Make Offer 2026-10-09, ownership review **UNKNOWN**; D-001/D-004/D-005 Sedo **UNKNOWN** (`sales/listings-evidence-2026-10-21.md`) |
| 0.4 | Nameservers → `ns1.afternic.com` / `ns2.afternic.com` (target for 15% Basic / lower commission tier at sale). Confirm with **dns.google** (never box DNS; no Wayback). | API post-buy / `POST /list`, or Dvir via Afternic "Change NS" / registrar UI | dns.google shows Afternic pair within ≤24 h. **Live today:** D-001 and D-005 on Afternic NS; D-002/D-003/D-004 observed on Porkbun NS with Afternic lander via forward (`sales/sell-chance-2026-10-20.md`) — NS ≠ target is a known gap, not a new decision |
| 0.5 | `POST /list/{domain}` with approved mode, prices, `display_name` (CamelCase). First accepted listing anchors M6/M18 schedule. | Gavriel → DOM | 200; `listing_history` / price_schedule rows. **CR-070:** listing write needs WRITE token and marks the record "listed by hand / ours" — do **not** log a listing as ours when ownership is UNKNOWN |
| 0.6 | Afternic listing: `GET /export/afternic.csv` → upload at afternic.com/domains/add with **Update** (never Replace). Plan **Basic** (not Boost). Hybrid → Custom Lander (Buy Now + Make Offer); LTO off on the public listing. | Dvir (~3 min) | Afternic portfolio shows BIN, floor, min offer, correct lander. Screenshot → evidence. Confirm upload via `POST /export/afternic/uploaded` when DOM tracks it |
| 0.7 | One-time (not per name): Afternic payee + W-8BEN; Sedo seller KYC | Dvir | Payout method usable. Israeli payee dropdown status: **UNVERIFIED** in playbook |
| 1.1–1.2 | Lander check at +24 h / +48 h (headless browser; curl gets JS stub / 403). Exact BIN in title; no "registered but may still be available" dead page | Gavriel / Sales watch | Screenshot + HTML under `deals/D-NNN/evidence/` |
| 1.3 | Sedo **Make Offer** (if 0.3 passed): asking price = BIN (non-binding); min offer = marketplace min ($100 non-geo), **never** the walk-away | Dvir | Public Sedo shows name + min. Binding BIN stays on Afternic only |
| 60.1 | **Fast Transfer** after ~60 days at a Premium-Network registrar (GoDaddy: usually auto opt-in at lock end; Porkbun: account setting + approve). Separate from NS commission rule. | Dvir checks / approves | Dashboard Fast Transfer = yes; lander may show FAST TRANSFER badge. **D-001 target ~2026-12-03**; D-005 ~60 days after GoDaddy landing; Porkbun eligibility for D-002..D-004 **UNKNOWN** |
| Ledger after list | Update `ledger/portfolio.csv` (`bin_usd`, `floor_usd`, `walkaway_usd`, `status=listed` / transferred). Append cost rows only via allowed routes. Sales owns ledger under CFO absorb (`org/org-v2.md`, `knowledge/handoffs/cfo.md`) | Sales / Gavriel | Portfolio matches approved card; DOM books are source of truth for money when live |
| Ongoing | Monday T-SELL snapshot: one new row per owned name per venue in `sales/sale-rate-weekly.csv`; views/leads/offers read or `n/a`+reason; compare `price_shown_usd` to `bin_usd` → any diff = `MISMATCH` same day to Gavriel; never edit old rows | Sales | Playbook weekly (Monday, IDT; T-SELL) row |

**Binding-price rule (current):** Afternic holds the only binding BIN + Fast Transfer path. Sedo (and any other venue) is **non-binding Make Offer** so a name cannot sell twice (`sales/playbook.md` decisions table).

**Public LTO:** **off** on the listing (adopted rule). Private ≤12-month plan via Afternic Custom Checkout Link only if a buyer says "too expensive" — that path still needs Dvir yes on the reply. Open conflict: D-005 list approval line in `ledger/approvals-log.csv` (2026-10-19) said "LTO on" while B-07 / listing rule is no public LTO (`knowledge/evidence-ledger.md` B-07). Treat public LTO as **off** until Dvir re-settles that name.

---

## 2. Formula vs judgment

### Fixed formula (no Sales rewrite without a new Dvir decision)

| Item | Formula / rule | Cite |
|---|---|---|
| BIN ladder (non-geo, pricing v3) | Only from `{299, 399, 499, 788, 1088, 1488, 1988, 2488}`; default non-geo **$1,488** | playbook §5.0 / listing-strategy v9.1 |
| Floor | **65% of BIN**, whole dollar (v3); never below **$750**. `$1,488 → $967` | playbook §5.0; `ledger/portfolio.csv` |
| Walk-away (private) | **max(48% of BIN, $500)**, rounded to **nearest $5** (BUG-049; ties up). `$1,488 → $715`. Never exported / never on lander / never told to buyer | DOM BUG-049; `company/decisions-log.md`; `sales/offers.md` |
| Marketplace min offer | **$100** non-geo (Dvir 2026-10-05 01:03) | playbook; listing.md |
| Offer bands | `< walk-away` → auto-decline + log; `walk-away ≤ offer < floor` → Dvir; `≥ floor` on Afternic → auto-accept / standing yes; Sedo ≥ floor → still Dvir (no Sedo auto-accept) | `sales/offers.md`; D-2026-10-13-01 |
| Schedule drops | Pre-approved on buy card; heads-up to Dvir only (v3 step-down list for non-geo; final push = lowest list ≥ floor) | playbook §5.0 |
| Public LTO | **Off** | playbook decision 7; D-001 listing.md; B-07 |
| Afternic plan | **Basic** (not Boost) at upload | playbook Day 0 0.6 |
| Cap | $1,500 / 40 names (purchase all-in); renewals/AI outside cap | `knowledge/handoffs/cfo.md` |

**Recorded exceptions (still current):**

- **D-001 walk-away = $950** (not formula $715 / historical $960). Dvir 2026-10-06; kept in `sales/offers.md` and `ledger/portfolio.csv`.
- **D-005 prices** = $1,488 / $967 / $715 under **D-2026-10-20-D005-PRICE** (replaced earlier $3,488 / $2,267 plan). Afternic **ownership of the live $1,488 page = UNKNOWN** without signed-in All Domains proof (`sales/listings-evidence-2026-10-21.md`).

### Sales / human judgment (propose only; Dvir decides money)

- Which BIN rung to propose on the buy card when comps / demand leave room between ladder points (default still $1,488 unless evidence supports $1,988/$2,488 per v3 gates).
- Whether to use Sedo at all for a name (0.3 / 1.3); timing vs NS switch.
- Counter text for mid-range offers (one counter near full BIN, 48 h — Dvir still approves the draft).
- Renew-vs-drop recommendation (Rule 14 / CFO handoff); Dvir Gate F.
- Flagging MISMATCH / UNKNOWN listing ownership; never invent ownership from a public page alone.
- Draft outreach (paused) and offer replies — always drafts; never send.

---

## 3. When the Dvir card fires

Org rule (`org/org-v2.md`): Dvir approves every buy, price, listing, outreach. Gavriel is the only bot that executes money actions after that yes.

| Action | Dvir card / one-tap yes? | Notes |
|---|---|---|
| Buy (Gate A) | **Yes** | Buy card; often combined with Gate B sell plan |
| Initial list + price schedule (Gate B) | **Yes** (usually on same buy card) | Includes BIN, floor, walk-away, min, LTO off, lander mode |
| Change BIN / floor / walk-away / schedule away from approved plan | **Yes** | New decision ID in `company/decisions-log.md` |
| Afternic CSV upload / Add Domains (0.6) | **Yes** (Dvir does the click; bots hold no marketplace login) | Gavriel prepares export |
| Sedo add / verify / Make Offer submit (0.3, 1.3) | **Yes** (Dvir dashboard) | Sales does not sign in |
| Nameserver change to Afternic (0.4) when not done by API | **Yes** if Dvir must click registrar/Afternic UI | API may set NS on Porkbun buys |
| Public lease-to-own on / off | **Yes** | Current default **off**; any on-switch is a money/listing change |
| Fast Transfer opt-in / confirm (60.1) | **Yes** (check or approve) | GoDaddy often auto; Porkbun needs account setting |
| Outreach send (Gate C) | **Yes**, and **currently PAUSED** (no postal address; Legal open since ~2026-10-19) | Sales drafts → Risk Gate/Shomer → Dvir sends from his mailbox only |
| Offer mid-range / Sedo ≥ floor / email negotiation (Gate D) | **Yes** before any buyer-facing reply | Afternic ≥ floor auto-closes under standing yes D-2026-10-13-01; still log |
| Transfer / push / auth code (Gate E) | **Yes** | Never before marketplace holds funds |
| Renew or drop (Gate F) | **Yes** | Sales/CFO recommends only |
| Delist near drop | **Yes** (Dvir pulls listings) | playbook end-of-life |
| Price-drop events already on approved schedule | **Heads-up only** (no new card) | Unless HOLD or change from plan |
| Monday snapshot / lander recheck / ledger cost rows / offer logging | **No** (Sales / Gavriel ops) | Report MISMATCH same day; no price edit |
| Propose pricing / listing plan text | **No card to act** — draft to Gavriel | Becomes a card when Gavriel asks Dvir |

**Standing yes (not a per-sale card):** Afternic BIN sale at approved BIN, or Afternic offer ≥ floor, closes and is logged (D-2026-10-13-01). Does **not** cover Sedo, email closes, off-platform pay, LTO on, price changes, or outreach.

---

## 4. UNKNOWN gaps (block a complete closed-loop path)

1. **Sedo status for all five names** — no signed-in verification proof; D-002/D-003 "ownership review" not confirmed; others no submission record (`sales/listings-evidence-2026-10-21.md`).
2. **D-005 mineunited.com Afternic ownership** — public page shows $1,488; DOM export / All Domains not proven ours.
3. **D-002/D-003/D-004 live NS** — Porkbun NS observed vs target Afternic NS; commission tier at sale depends on NS at sale time; switching needs Dvir yes.
4. **Fast Transfer opt-in state** — not confirmed in-dashboard for any name; Porkbun eligibility UNKNOWN.
5. **D-005 LTO line** — 2026-10-19 approval text said "LTO on" vs standing no-public-LTO rule (B-07 conflict).
6. **Afternic commission plan live** — playbook instructs Basic (15%/25%); sell-chance math used Boost-style 20%/30% figures; actual Boost on/off per name **UNKNOWN** without dashboard.
7. **DOM listing provenance** — CR-070: bots must not write listing rows that falsely claim ownership; provenance field still with DOM Architect.
8. **Outreach** — paused; path exists in playbook but is not runnable until postal address + Legal clear.

Until (1)–(2) and signed-in checks clear, Sales treats venue ownership as evidence-graded (proven-ours / seen-public-only / UNKNOWN) and does not mark UNKNOWN listings as ours in DOM.

---

## 5. Role map (current)

| Role | Does | Does not |
|---|---|---|
| Sales | Listing/price **plans**, offer drafts, Monday snapshot, ledger/renewal/cost records, MISMATCH flags | Buy, list, change price, send outreach, message Dvir |
| Gavriel | Coordinates; executes money actions after Dvir yes; decisions log | Self-grade |
| Dvir | Every Gate A–F yes; marketplace UI clicks bots cannot do | — |
| DOM Architect | DOM API / listing provenance / books | Sales policy |
| Risk Gate | Outreach/legal gates when outreach unpaused | List/price |

