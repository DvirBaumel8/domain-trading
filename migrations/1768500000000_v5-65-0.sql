-- Up Migration
-- v5.65.0 (F43, F44). F43: auction_outcomes keeps the price seen before the last one, so the report can count auctions that jumped in the last snapshot window.
-- F44: renew_views_min = the 30-day Afternic views at or above which a name's renewal signal is "renew" (advice only; Dvir decides every renewal).
ALTER TABLE public.auction_outcomes ADD COLUMN prev_seen_price_cents integer;
ALTER TABLE public.settings ADD COLUMN renew_views_min integer NOT NULL DEFAULT 10 CHECK (renew_views_min BETWEEN 1 AND 10000);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN renew_views_min;
ALTER TABLE public.auction_outcomes DROP COLUMN prev_seen_price_cents;
