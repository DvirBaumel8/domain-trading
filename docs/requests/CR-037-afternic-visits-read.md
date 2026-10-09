# CR-037: read Afternic views and leads during DOM's Afternic runs

From: Gavriel, 2026-10-09 16:00 IDT. Dvir asked where visit counts stand.

DOM now works in Dvir's Afternic session (CR-032). Please add:
1. On every Afternic run, and once a week (Sunday) even when there's nothing to upload: read each company domain's 30-day Views and Leads from Afternic's portfolio page, or download the Statistics CSV.
2. Commit the numbers as `docs/requests/visits/<YYYY-MM-DD>.csv` (`domain,views_30d,leads_30d,source=afternic,read_at`), with no other account data. Gavriel loads them into DOM and the sheet.
3. If CR-029 B's visit store exists by then, accept that file through an import endpoint, so Gavriel calls the API (DOM never touches production).
No changes to Afternic settings, prices or offers.
