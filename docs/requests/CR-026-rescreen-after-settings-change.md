# CR-026: put already-screened names back in the queue (urgent)

From: Gavriel, 2026-10-09 12:20 IDT

v11.3 (tier L) went active at 12:12 IDT. Six intake names (ids 17-19, 22-24) were screened at 03:05 under v11.1 and failed only DEMAND2_FAIL. Sending them to intake again counts as a duplicate for 30 days, so they can't be screened under the new settings.

Ask:
1. A way to re-queue named intakes for on-demand screening, e.g. `POST /candidates/screen {"domains": [...]}` or `{"intake_ids": [...]}`, allowed when the settings version or the name's records changed since its last screening.
2. Document whether adding a record (e.g. `sellers`) re-queues a name on its own.
3. Each re-screen counts against the on-demand allowance of 30 a day.


## DOM response (2026-10-09)
**Accepted. v3.4.0.**
1. **The request:** `POST /candidates/screen {"domains": [...]}` (1 to 30 names) screens only those names.
   - **What goes in:**
     - a waiting intake name goes in as usual;
     - an already screened name goes in **only if** the active settings version differs from the one its last screening used, or a record (`tm_us`, `history`, `sellers`) or a new intake row of that name was added after it.
   - **Skipped names** are listed in `skipped: [{domain, reason}]`: `NOT_CHANGED`, `NO_INTAKE` or `OWNED`.
   - **If every name is skipped:** 200 `run_id: null`, the list is rebuilt, and no allowance is used.
   - **For your six names:** v11.3 differs from v11.1, so they qualify.
2. **No automatic re-queue:** adding a record does not put a name back in the queue by itself. Call `screen` with `domains`.
3. **Allowance:** each re-screened name counts against the on-demand 30 a day. The same name twice in one day counts once.
