-- Up Migration
-- v5.58.0 (CR-079): tag the CR-076 R-4 seed rows of venue_listings as `approval_source = 'seed_cr076'`, so the daily ownership check (LISTING_UNAPPROVED) grandfathers them.
-- venue_listings is append-only (UPDATE is refused by trigger). The column is new and nullable; the append-only trigger is switched off for this one statement only,
-- inside this migration's transaction, and the tag touches nothing but the new column of the seed rows (identified exactly as 5.27.0 wrote them: ours_confirmed, no token, no audit row,
-- evidence source 'CR-076 R-4 seed'). Every other row, and every other column, stays as written.
ALTER TABLE public.venue_listings ADD COLUMN approval_source text CHECK (approval_source IS NULL OR approval_source IN ('seed_cr076'));
ALTER TABLE public.venue_listings DISABLE TRIGGER venue_listings_append_only;
UPDATE public.venue_listings SET approval_source = 'seed_cr076'
WHERE provenance = 'ours_confirmed' AND token_name IS NULL AND audit_id IS NULL AND evidence->>'source' = 'CR-076 R-4 seed';
ALTER TABLE public.venue_listings ENABLE TRIGGER venue_listings_append_only;

-- Down Migration
ALTER TABLE public.venue_listings DROP COLUMN approval_source;
