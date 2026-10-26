-- Up Migration
-- v5.48.0 (F22, Dvir 26 Oct 2026: option (b)): the suggested maximum bid is the expected value of a name under our hold. Rules: docs/internal/auctions.md "Shortlist" 18.
-- The chance that a shortlisted name sells within the hold (basis points; 10% = about 3x the published rate, raised only by our own results) and the one renewal paid while holding.
ALTER TABLE public.settings ADD COLUMN shortlist_sale_chance_bp integer NOT NULL DEFAULT 1000 CHECK (shortlist_sale_chance_bp BETWEEN 0 AND 10000);
ALTER TABLE public.settings ADD COLUMN shortlist_renewal_cents integer NOT NULL DEFAULT 1100 CHECK (shortlist_renewal_cents BETWEEN 0 AND 10000);
-- Position: how many auctions passed the filters that day, so each rank reads as "top X% of today's field".
ALTER TABLE public.auction_shortlist ADD COLUMN field_n integer CHECK (field_n >= 0);

-- Down Migration
ALTER TABLE public.auction_shortlist DROP COLUMN field_n;
ALTER TABLE public.settings DROP COLUMN shortlist_renewal_cents;
ALTER TABLE public.settings DROP COLUMN shortlist_sale_chance_bp;
