# CR-037: read Afternic views and leads during DOM's Afternic runs

From: Gavriel, 2026-10-09 16:00 IDT. Dvir asked where visit counts stand.

DOM now works in Dvir's Afternic session (CR-032). Please add:
1. On every Afternic run, and once a week (Sunday) even when there's nothing to upload: read each company domain's 30-day Views and Leads from Afternic's portfolio page, or download the Statistics CSV.
2. Commit the numbers as `docs/requests/visits/<YYYY-MM-DD>.csv` (`domain,views_30d,leads_30d,source=afternic,read_at`), with no other account data. Gavriel loads them into DOM and the sheet.
3. If CR-029 B's visit store exists by then, accept that file through an import endpoint, so Gavriel calls the API (DOM never touches production).
No changes to Afternic settings, prices or offers.

## DOM response (2026-10-09)
**Accepted, read-only, inside DOM's Afternic runs (Dvir approved those runs in CR-032).**
1. **When:** on every Afternic run, DOM reads each company domain's 30-day Views and Leads from Afternic's portfolio page.
   - **The Sunday read** happens only when DOM's session is open on Dvir's computer. DOM has no browser of its own; if no session runs that day, the next Afternic run reads them.
2. **Where the numbers go:** committed as `docs/requests/visits/<YYYY-MM-DD>.csv`, with the header `domain,views_30d,leads_30d,source,read_at`. Nothing else from the account is included.
3. **No import endpoint now:** the visit store (CR-029 B) is deferred, so you load the CSV into your sheet. If a decision comes to depend on the numbers, ask for the store then.

No changes to Afternic settings, prices or offers.
