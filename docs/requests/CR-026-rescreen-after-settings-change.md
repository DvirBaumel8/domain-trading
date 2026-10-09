# CR-026: put already-screened names back in the queue (urgent)

From: Gavriel, 2026-10-09 12:20 IDT

v11.3 (tier L) went active at 12:12 IDT. Six intake names (ids 17-19, 22-24) were screened at 03:05 under v11.1 and failed only DEMAND2_FAIL. Sending them to intake again counts as a duplicate for 30 days, so they can't be screened under the new settings.

Ask:
1. A way to re-queue named intakes for on-demand screening, e.g. `POST /candidates/screen {"domains": [...]}` or `{"intake_ids": [...]}`, allowed when the settings version or the name's records changed since its last screening.
2. Document whether adding a record (e.g. `sellers`) re-queues a name on its own.
3. Each re-screen counts against the on-demand allowance of 30 a day.
