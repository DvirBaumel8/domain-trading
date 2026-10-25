-- Up Migration
-- v5.45.0 (G-127): the daily auction shortlist. The datasave step auctionShortlist scores the in-range GoDaddy auctions (godaddy_auctions_live) that end soon,
-- keeps the best ones here (replaced per data date) and stores an automatic pre-bid for the top names. Read by GET /auctions/shortlist and GET /auctions/funnel.
-- Not in the backup (derived daily data).
CREATE TABLE public.auction_shortlist (
  data_date date NOT NULL,
  domain text NOT NULL CHECK (domain = lower(domain)),
  rank integer NOT NULL CHECK (rank >= 1),
  score double precision NOT NULL CHECK (score >= 0 AND score <= 100),
  score_version text NOT NULL,
  parts jsonb NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  bids integer NOT NULL CHECK (bids >= 0),
  end_time timestamptz NOT NULL,
  auction_type text,
  valuation_cents integer,
  domain_age integer,
  pageviews integer,
  max_bid_suggested_cents integer NOT NULL CHECK (max_bid_suggested_cents >= 0),
  reasons text[] NOT NULL DEFAULT '{}',
  prebid_id bigint,
  prebid_verdict text CHECK (prebid_verdict IN ('pass', 'flag', 'fail')),
  dropped_reason text,
  generated_at timestamptz NOT NULL,
  PRIMARY KEY (data_date, domain)
);
CREATE INDEX auction_shortlist_rank_idx ON public.auction_shortlist (data_date, rank);

-- shortlist size and horizon, how many names get the endings check and the automatic pre-bid, and the days the rows are kept (migration only)
ALTER TABLE public.settings ADD COLUMN shortlist_horizon_hours integer NOT NULL DEFAULT 72 CHECK (shortlist_horizon_hours BETWEEN 1 AND 240);
ALTER TABLE public.settings ADD COLUMN shortlist_size integer NOT NULL DEFAULT 25 CHECK (shortlist_size BETWEEN 1 AND 100);
ALTER TABLE public.settings ADD COLUMN shortlist_endings_n integer NOT NULL DEFAULT 50 CHECK (shortlist_endings_n BETWEEN 0 AND 200);
ALTER TABLE public.settings ADD COLUMN shortlist_prebid_n integer NOT NULL DEFAULT 10 CHECK (shortlist_prebid_n BETWEEN 0 AND 25);
ALTER TABLE public.settings ADD COLUMN shortlist_keep_days integer NOT NULL DEFAULT 90 CHECK (shortlist_keep_days BETWEEN 7 AND 365);
-- a realistic end-user resale price for the suggested maximum bid (knowledge base end-user-price-band: median about $595-$1,300); not our list price
ALTER TABLE public.settings ADD COLUMN shortlist_expected_resale_cents integer NOT NULL DEFAULT 100000 CHECK (shortlist_expected_resale_cents BETWEEN 10000 AND 1000000);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN shortlist_expected_resale_cents;
ALTER TABLE public.settings DROP COLUMN shortlist_keep_days;
ALTER TABLE public.settings DROP COLUMN shortlist_prebid_n;
ALTER TABLE public.settings DROP COLUMN shortlist_endings_n;
ALTER TABLE public.settings DROP COLUMN shortlist_size;
ALTER TABLE public.settings DROP COLUMN shortlist_horizon_hours;
DROP TABLE public.auction_shortlist;
