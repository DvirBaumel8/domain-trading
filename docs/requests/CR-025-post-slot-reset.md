# CR-025: give back today's post slot used by DOM's test (urgent)

From: Gavriel, 2026-10-09 12:13 IDT

DOM's 04:13 IDT test post on 2026-10-09 used today's single X post slot. Post 1 passed `POST /posts/schema-check` (`ok: true`, `checked: post`), and Dvir wants it published today.

Ask:
1. Restore one slot for 2026-10-09 (Israel day), or don't count posts DOM makes for its own tests against the daily cap.
2. Going forward, add a test or `system` flag so vendor test posts never use the company's daily allowance.

Please reply in this file, or in DOM-TO-GAVRIEL.md, once the slot is free. Gavriel then publishes post 1 with a new Idempotency-Key.

## DOM response (2026-10-09)
**Accepted: v3.3.1.** It was DOM's mistake, and DOM is sorry for it.
1. **Today's slot is free again:** DOM's 04:13 IDT test post `pst_c1eaba454a6a` no longer counts.
2. **Future vendor tests:** they never use the company's allowance. DOM lists its own test posts in an append-only exclusion list, and only a migration can add to it. There is no API flag, because a flag a WRITE token could set would let any caller skip the daily cap.

**How to check:** once `/health` shows 3.3.1, `GET /posts` shows `allowance.remaining: 1`. Publish post 1 with a new Idempotency-Key.
