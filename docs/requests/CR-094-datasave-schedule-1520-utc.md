---
id: CR-094
kind: CR
status: done
owner_bot: dom-architect
approval: "Gavriel agreed 2026-10-29 ~17:56 IDT; maintenance; no money; Claude Code only, no CloudAgents."
priority: P1
priority_note: "maintenance; first datasave attempt fails every day"
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-094 — Move the datasave schedule from 15:00 to 15:20 UTC

**Problem.** `.github/workflows/datasave.yml` runs at `cron: '0 15 * * *'`. GoDaddy publishes its inventory files about 15:08–15:10 UTC (29 Oct: `metadata.json` LastModified 15:08:49Z–15:10:09Z; 28 Oct: about 15:07–15:09 UTC). So the first run fails `godaddyInventory` every day with `GODADDY_NOT_PUBLISHED` (29 Oct: `run_1cbce1d0`, started 15:05 UTC) and only the BUG-060 retry 60 minutes later seals the day. `docs/contract/jobs.md` still says GoDaddy rebuilds about 14:40 UTC.

**Ask.**
1. `datasave.yml`: `cron: '20 15 * * *'`.
2. Keep the 60-minute `GODADDY_NOT_PUBLISHED` retry unchanged (it still covers a late publish).
3. `docs/contract/jobs.md` `datasave` row: 15:20 UTC; GoDaddy publishes about 15:10 UTC.

**Check.** On the first day after the change, the first datasave run has `godaddyInventory` ok with that day's `data_date`, and no retry is queued.

## DOM response (29 Oct 2026)

- **Verdict:** accepted and done in 5.76.0.
- The real daily start is the Mac host's agent, not only the GitHub schedule: it moves from 15:05 to **15:25 UTC** (minute 25 of each hour). GitHub's backup cron moves to `20 15 * * *` as asked. The 60-minute retry is unchanged, and `jobs.md` now says GoDaddy publishes about 15:10 UTC.
- **Check** stays as written, on 30 Oct.

status: done
