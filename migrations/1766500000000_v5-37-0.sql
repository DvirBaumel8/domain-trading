-- Up Migration
-- v5.37.0: GoDaddy auctions inside the buying range (S8 cap, settings.s8_max_price_cents) that already have bids. Written by the datasave step
-- godaddyInventory (parseAuctions), read by GET /auctions/live. Not in the backup (rebuilt by the next daily files).
CREATE TABLE public.godaddy_auctions_live (
  data_date date NOT NULL,
  domain text NOT NULL CHECK (domain = lower(domain)),
  end_time timestamptz NOT NULL,
  auction_type text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  bid_count integer NOT NULL CHECK (bid_count >= 0),
  domain_age integer,
  valuation_cents integer,
  pageviews integer,
  PRIMARY KEY (data_date, domain)
);
CREATE INDEX godaddy_auctions_live_end_idx ON public.godaddy_auctions_live (data_date, end_time);

-- days the rows are kept, and the fewest bids an auction needs to be kept (migration only)
ALTER TABLE public.settings ADD COLUMN datasave_auction_live_keep_days integer NOT NULL DEFAULT 7 CHECK (datasave_auction_live_keep_days BETWEEN 1 AND 30);
ALTER TABLE public.settings ADD COLUMN datasave_auction_live_min_bids integer NOT NULL DEFAULT 1 CHECK (datasave_auction_live_min_bids >= 1);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN datasave_auction_live_min_bids;
ALTER TABLE public.settings DROP COLUMN datasave_auction_live_keep_days;
DROP TABLE public.godaddy_auctions_live;
