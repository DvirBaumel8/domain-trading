-- Up Migration
-- v5.41.0: the least final price (cents) at which an ended GoDaddy auction is kept in godaddy_auctions (was the fixed $500). The datasave step engineFeed
-- turns ended auctions with at least one bid at or above this price into engine_sales rows. market_names keeps its own $500 floor (market/common.ts MIN_CENTS).
-- Migration only; never lower than $1.
ALTER TABLE public.settings ADD COLUMN datasave_auction_min_cents integer NOT NULL DEFAULT 10000 CHECK (datasave_auction_min_cents >= 100);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN datasave_auction_min_cents;
