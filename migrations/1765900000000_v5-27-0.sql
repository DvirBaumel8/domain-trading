-- Up Migration
-- v5.27.0 (CR-076): provenance of every venue record. venue_listings is append-only (UPDATE and DELETE are refused by trigger), so:
--  * ADD COLUMN ... DEFAULT 'unknown' fills the existing rows without a row update (PostgreSQL keeps the default in the catalog; no UPDATE trigger fires),
--    so every existing row reads `unknown` (R-1) and the trigger is never disabled;
--  * the R-4 seed is written as NEW appended rows (the latest row per domain and venue decides), never as an update of an old row.
-- Each seed row is guarded: it is a no-op when the domain is not in the portfolio, when the latest row for that venue already says the same, or (ours_confirmed)
-- when the latest row for that venue is a removal (a delisting made later wins over the evidence of 2026-10-13).
ALTER TABLE public.venue_listings
  ADD COLUMN provenance text NOT NULL DEFAULT 'unknown' CHECK (provenance IN ('ours_confirmed', 'observed_public', 'unknown')),
  ADD COLUMN seen_price_cents integer CHECK (seen_price_cents IS NULL OR seen_price_cents > 0),
  ADD COLUMN seen_url text,
  ADD COLUMN seen_at timestamptz,
  ADD CONSTRAINT venue_listings_observed_fields CHECK (provenance <> 'observed_public' OR (seen_price_cents IS NOT NULL AND seen_url IS NOT NULL AND seen_at IS NOT NULL));

-- R-4: ours_confirmed Afternic BIN $1,488 (proven by the Afternic upload of 2026-10-13 18:32 IDT for promptinjectionaudit.com; the other three from Sales' evidence 2026-10-21)
INSERT INTO public.venue_listings (domain, venue, listed_at, delisted, mode, price_cents, min_offer_cents, evidence, note, token_name, audit_id, provenance)
SELECT s.domain, 'afternic', s.listed_at, false, 'bin', 148800, NULL,
  jsonb_build_object('source', 'CR-076 R-4 seed', 'ref', 'sales/listings-evidence-2026-10-21.md'),
  'Seeded by migration 5.27.0 (CR-076 R-4): Afternic Buy Now $1,488.', NULL, NULL, 'ours_confirmed'
FROM (VALUES
  ('promptinjectionaudit.com', TIMESTAMPTZ '2026-10-13 15:32:00+00'),
  ('ukcbamcompliance.com', now()),
  ('aievalsconsulting.com', now()),
  ('roofingvoiceagent.com', now())
) AS s(domain, listed_at)
WHERE EXISTS (SELECT 1 FROM public.domains d WHERE d.domain = s.domain)
  AND NOT EXISTS (
    SELECT 1 FROM public.venue_listings v
    WHERE v.domain = s.domain AND v.venue = 'afternic'
      AND v.id = (SELECT max(x.id) FROM public.venue_listings x WHERE x.domain = s.domain AND x.venue = 'afternic')
      AND (v.delisted OR v.provenance = 'ours_confirmed'));

-- R-4: mineunited.com on Afternic was only SEEN on the public page (2026-10-20): observed_public, never counted as ours
INSERT INTO public.venue_listings (domain, venue, listed_at, delisted, mode, price_cents, min_offer_cents, evidence, note, token_name, audit_id, provenance, seen_price_cents, seen_url, seen_at)
SELECT 'mineunited.com', 'afternic', TIMESTAMPTZ '2026-10-20 12:00:00+00', false, 'observed', NULL, NULL, NULL,
  'Seeded by migration 5.27.0 (CR-076 R-4): seen on the public Afternic page, not confirmed as ours.', NULL, NULL, 'observed_public',
  148800, 'https://www.afternic.com/domain/mineunited.com', TIMESTAMPTZ '2026-10-20 12:00:00+00'
WHERE EXISTS (SELECT 1 FROM public.domains d WHERE d.domain = 'mineunited.com')
  AND NOT EXISTS (
    SELECT 1 FROM public.venue_listings v
    WHERE v.domain = 'mineunited.com' AND v.venue = 'afternic'
      AND v.id = (SELECT max(x.id) FROM public.venue_listings x WHERE x.domain = 'mineunited.com' AND x.venue = 'afternic')
      AND v.provenance = 'observed_public');

-- R-4: Sedo for ukcbamcompliance.com and aievalsconsulting.com is `unknown` (submitted 2026-10-09, "in ownership review"): any existing Sedo row is already `unknown`
-- through the column default, and no row is appended (an appended row would look like a live hand-listing in the export block).

-- Down Migration
-- The seed rows stay (the table is append-only); only the columns go.
ALTER TABLE public.venue_listings DROP CONSTRAINT venue_listings_observed_fields;
ALTER TABLE public.venue_listings DROP COLUMN seen_at, DROP COLUMN seen_url, DROP COLUMN seen_price_cents, DROP COLUMN provenance;
