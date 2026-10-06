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
