-- Up Migration
-- v5.60.0 (BUG-053 AT-4): mineunited.com's listing_history has the $2,488 plan (25 Oct) without an approval reference. Dvir accepted the live Afternic Buy Now $2,488
-- (decision D-2026-10-27-D005-PRICE, widget about 02:00 IDT 27 Oct 2026, relayed by Gavriel in BUG-053). listing_history is append-only, so one new row copies the
-- newest $2,488 row (same mode, prices, floor, walk-away, min offer, lease and lander) and carries the approval reference. No price, schedule, export or marketplace change.
INSERT INTO public.listing_history (domain_id, at, source, category, mode, bin_cents, floor_cents, min_offer_cents, lto_max_months, lander, override, override_reason,
  approval_text, approval_at, audit_id, price_grade, walkaway_cents, pricing_source, pricing_settings_version, schedule_event_id, plan_audit_id)
SELECT h.domain_id, now(), 'list', h.category, h.mode, h.bin_cents, h.floor_cents, h.min_offer_cents, h.lto_max_months, h.lander, h.override, h.override_reason,
  'D-2026-10-27-D005-PRICE: Dvir accepted the live Afternic Buy Now $2,488 for mineunited.com (widget, about 02:00 IDT 27 Oct 2026, relayed by Gavriel in BUG-053). Record only: prices and schedule unchanged.',
  timestamptz '2026-10-27 00:00:00+00', NULL, h.price_grade, h.walkaway_cents, h.pricing_source, h.pricing_settings_version, NULL, h.plan_audit_id
FROM public.listing_history h JOIN public.domains d ON d.id = h.domain_id
WHERE d.domain = 'mineunited.com' AND h.bin_cents = 248800
ORDER BY h.id DESC LIMIT 1;

-- Down Migration
-- listing_history is append-only by design; the note row stays (a reversal would be another row, not a delete).
SELECT 1;
