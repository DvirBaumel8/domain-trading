# CR-001 hold: CAP-07 and CAP-10 pending CR-002

| Field | Value |
|---|---|
| **To** | DOM (vendor) |
| **From** | Gavriel, on behalf of Dvir |
| **Re** | CR-001 (`docs/requests/CR-001-selection-checks.md`), DOM response §11 |
| **Status** | **Approved by Dvir, 2026-10-06 03:00 IDT** |

Thanks for the §11 answers. We acknowledge the CR-001 accepted-with-changes plan (P1a/P1b).

## Please hold (P1a)

Please **HOLD CAP-07 (history check)** and **CAP-10 (sibling/neighbor check)** until CR-002 arrives. CR-002 is expected within about 2 hours, after Dvir approves it.

**Why:** a backtest of 226 sold vs 284 dropped names produced selection rules v10, which:

- **(a)** rejects only *harmful* history (malware, spam, adult, scam, trademark-abuse use), not any past business use. Expired names with clean history become the main buying lane.
- **(b)** makes **registered-sibling share >= 0.50** a gate (counting siblings with prior history, or another extension registered before the .com). This replaces the in-use share >= 0.25 gate.

## Heads-up (P1b, no hold needed yet)

CR-002 will also change:

- **CAP-16**: lead count becomes outreach-only, not a buy gate.
- **CAP-18**: profit/Ratio inputs that depend on lead counts.
- **CAP-19**: the screening pack gate list.
- **CAP-20**: the live-run gate order.
- **CAP-12**: needs registration dates on other extensions.

## Continue as planned

Continue all other P1a capabilities as planned: CAP-00, 01, 02, 03, 04, 05, 11, 17, 18, 20. For CAP-20, the DR-003 replay expectations will be updated by CR-002.

## Missing documents

- §11.1 P-6 references `docs/internal/gaps.md`, which does not exist on main.
- `docs/contract/` and `docs/releases/v1.0.0.md` are not published yet.

Please publish these when ready.

---

## DOM response (2026-10-06 03:10 IDT)

**Hold acknowledged.** CAP-07 (history) and CAP-10 (sibling census) are on hold until CR-002. P1a continues with CAP-00, 01, 02, 03, 04, 05, 11, 17, 18 and 20.

1. **CAP-18 inputs.** CAP-18 ships with the price list (`pricing_settings` v3) and the EV/Ratio formulas, with lead counts as an explicit input `n`. CR-002 can change where `n` comes from, or drop it, without a rebuild. **CAP-20** ships with a configurable gate list per lane, so the CR-002 gate order is a settings change.
2. **"Expired names as the main buying lane" vs founder rule 5.** The rule says: never premium or aftermarket names, auctions or backorders.
   - DOM builds for expired names **only once they have dropped and are available for a normal registration** at the standard price.
   - Drop-catching, backorders, expired-name auctions and aftermarket purchases remain refused.
   - If CR-002 needs any of those, it must say so explicitly and carry Dvir's approval to change rule 5. DOM will push back on cost and risk.
3. **Harmful-history sources (CR-002 (a)).** Classifying malware, spam, adult, scam and trademark-abuse use needs the same sources as CAP-05 and CAP-06, plus archive content. The CR-001 §11 positions still apply: no undocumented website endpoints, and Web Risk is `MANUAL_REQUIRED` until a key exists.
4. **Missing documents.** `docs/contract/` v1.0.0, `docs/releases/v1.0.0.md` and `docs/internal/gaps.md` are being written now and will be published today. DOM will add a line here when they land.

**DOM, 2026-10-06:** published on main: `docs/contract/` v1.0.0 (+ `CHANGELOG.md`), `docs/releases/v1.0.0.md`, `docs/internal/gaps.md`, and templates in `docs/requests/README.md` and `docs/releases/README.md`. The inherited specs moved to `docs/internal/` (DOM-internal; the contract is the interface).
