-- Up Migration
-- v5.20.1, two data changes. Both are guarded so a re-run (or another database state) changes nothing.

-- BUG-047 item 1: mineunited.com (S8, Line 2) Buy Now $3,488 -> $1,488.
-- Dvir's approval, 2026-10-20 17:24 IDT, verbatim: "Yes, set mineunited.com to $1,488" (docs/requests/BUG-047-mineunited-price-and-missed-jobs.md).
-- The values are what the S8 plan code gives for a BIN of 148800 under pricing_settings v3 (floor 65% to the whole dollar, walk-away max(48% to $5, $500),
-- min offer $100; no M6/M18 drops for S8; final push = lowest list price >= floor = $1,088; the delist date is kept). Test M5201-1 derives them from the plan code.
-- The guard: lane S8, bin_cents 348800, pricing settings v3. A name in any other state is left alone.
CREATE TEMP TABLE bug047_target ON COMMIT DROP AS
  SELECT id, category, price_grade, lander, plan_audit_id FROM public.domains
  WHERE domain = 'mineunited.com' AND lane = 'S8' AND bin_cents = 348800 AND pricing_settings_version = 3;

INSERT INTO public.listing_history
  (domain_id, at, source, category, mode, bin_cents, floor_cents, min_offer_cents, lander, override, override_reason,
   approval_text, approval_at, audit_id, price_grade, walkaway_cents, pricing_source, pricing_settings_version, plan_audit_id)
SELECT t.id, now(), 'list', t.category, 'hybrid', 148800, 96700, 10000, t.lander, false, NULL,
  'BUG-047: Dvir, 2026-10-20 17:24 IDT: "Yes, set mineunited.com to $1,488" (bin_override 148800)', TIMESTAMPTZ '2026-10-20 14:24:00+00',
  NULL, t.price_grade, 71500, 'formula', 3, t.plan_audit_id
FROM bug047_target t;

-- the schedule: the planned rows (final push, delist) are superseded and re-written under a new plan id, same dates
WITH p AS MATERIALIZED (SELECT 'pl_' || gen_random_uuid()::text AS plan_id),
old AS (
  UPDATE public.price_schedule s SET status = 'superseded', updated_at = now()
  FROM bug047_target t WHERE s.domain_id = t.id AND s.status = 'planned'
  RETURNING s.domain_id, s.event, s.due_on
)
INSERT INTO public.price_schedule (domain_id, plan_id, event, due_on, bin_cents, floor_cents, walkaway_cents, settings_version, status)
SELECT o.domain_id, p.plan_id, o.event, o.due_on,
  CASE o.event WHEN 'final_push' THEN 108800 END,
  CASE o.event WHEN 'final_push' THEN 96700 END,
  CASE o.event WHEN 'final_push' THEN 71500 END,
  3, 'planned'
FROM old o CROSS JOIN p
WHERE o.event IN ('final_push', 'delist')
ORDER BY o.due_on;

-- the plan on the row, and the Afternic/Sedo export flag (the way a plan change sets it: listing_changed_at, export_pending_since)
UPDATE public.domains d SET
  bin_cents = 148800, floor_cents = 96700, walkaway_cents = 71500, min_offer_cents = 10000, pricing_source = 'formula',
  plan_id = COALESCE((SELECT s.plan_id FROM public.price_schedule s WHERE s.domain_id = d.id AND s.status = 'planned' ORDER BY s.id LIMIT 1), d.plan_id),
  listing_changed_at = now(), export_pending_since = COALESCE(d.export_pending_since, now()), updated_at = now()
FROM bug047_target t WHERE d.id = t.id;

-- CR-069 item 5 (AT-6): the shared `bots` token works (Gavriel, 20 Oct 2026), so the per-bot tokens are retired.
-- Gavriel's WRITE token, gavriel-read, visit-counter and bots-shared stay.
UPDATE public.api_tokens SET revoked_at = now()
WHERE revoked_at IS NULL
  AND ((scope = 'read' AND name IN ('data-engineer', 'scoring-scientist', 'shomer', 'buyer', 'dom-architect'))
    OR (scope = 'data' AND name = 'data-engineer-upload'));

-- Down Migration
-- Nothing to undo: a revoked token stays revoked (issue a new one), and the price fix is undone only by a new approved price change (a listing_history row, never a rollback).
SELECT 1;
