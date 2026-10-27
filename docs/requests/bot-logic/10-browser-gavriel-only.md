# Browser work = Gavriel only

**Status:** Standing (Dvir t973u / t974u, 2026-10-27 Asia/Jerusalem)  
**Also:** JOINT-OPS R9 · `docs/requests/NOTE-2026-10-27-browser-gavriel-only.md` · `docs/requests/README.md` standing rule

## Rule
Live browser / Chrome work on marketplaces and websites (Sedo, Afternic, registrars, dashboards, etc.) = **Gavriel (Grok Bot) ONLY**.

- Claude Code must not drive marketplace UIs.
- DOM / DOM Architect must not browser-automate those UIs.
- Other bots: same — no live Chrome for company marketplace work.
- Prefer APIs. If only a click path exists, hand the step to Gavriel (CR note or `GAVRIEL-TO-DOM.md`).
- **Handoff (t974u):** once we have real API access for a marketplace, that work moves to DOM.

## Why (short)
Claude Code Sedo UI froze; Gavriel browser path works. Dvir: apply anywhere.

## Pass/fail
- Pass: marketplace change via API, or Gavriel completes the browser step.
- Fail: Claude Code / DOM / other bot drives Sedo/Afternic/etc. Chrome for the company.
