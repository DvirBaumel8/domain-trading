-- Up Migration
-- v5.49.0 (improvement pass 26 Oct, P1-P5). Rules: docs/internal/auctions.md "Shortlist" (auction-v4, outcomes), closeouts.md "Closeout expiries", datasave.md.

-- ---- P1: closeout_expiries kept growing (the regime filter kept 51,003 names a day while only 1,500 are checked). The collector now keeps at most this many NEW names per run,
-- the ones with the smallest md5(domain) (deterministic and unbiased); never-checked rows past the end window are deleted by the step.
ALTER TABLE public.settings ADD COLUMN closeout_expiry_collect_max integer NOT NULL DEFAULT 1000 CHECK (closeout_expiry_collect_max BETWEEN 0 AND 20000);
-- One-time trim to the same idea: every checked or decided row stays; of the never-checked rows only the 15,000 with the smallest md5(domain). TRUNCATE gives the disk back at once.
CREATE TEMP TABLE closeout_expiries_keep ON COMMIT DROP AS
  SELECT * FROM public.closeout_expiries WHERE attempts > 0 OR final
  UNION ALL
  (SELECT * FROM public.closeout_expiries WHERE attempts = 0 AND NOT final ORDER BY md5(domain), domain, ends_at LIMIT 15000);
TRUNCATE public.closeout_expiries;
INSERT INTO public.closeout_expiries SELECT * FROM closeout_expiries_keep;

-- datasave_pool: keep 2 days (was 3). The (source, domain) index is not used: every query on the table names data_date (the primary key starts with it), checked in src.
ALTER TABLE public.settings ALTER COLUMN datasave_pool_keep_days SET DEFAULT 2;
UPDATE public.settings SET datasave_pool_keep_days = 2;
DROP INDEX public.datasave_pool_domain;

-- ---- P5: GoDaddy renews at about $23 (report.json: $23.19, $23.00), not $11. 10% x $800 - $23 = $57 -> $55 at full score.
ALTER TABLE public.settings ALTER COLUMN shortlist_renewal_cents SET DEFAULT 2300;
UPDATE public.settings SET shortlist_renewal_cents = 2300;

-- ---- P3: the free demand fields of the GoDaddy inventory rows (null = the row did not carry the field).
ALTER TABLE public.godaddy_auctions_live ADD COLUMN exact_match_tlds integer CHECK (exact_match_tlds >= 0);
ALTER TABLE public.godaddy_auctions_live ADD COLUMN developed_tlds integer CHECK (developed_tlds >= 0);
ALTER TABLE public.godaddy_auctions_live ADD COLUMN keyword_registrations integer CHECK (keyword_registrations >= 0);
ALTER TABLE public.godaddy_auctions_live ADD COLUMN search_volume integer CHECK (search_volume >= 0);
ALTER TABLE public.godaddy_auctions_live ADD COLUMN cpc_cents integer CHECK (cpc_cents >= 0);

-- ---- P4: paper trading. One row per (shortlist data date, name): the served top names (group shortlist) and a deterministic random control from the same field. The end state
-- is filled by the shortlist step from the newest godaddy_auctions_live snapshot; would_win only for shortlist rows. Not append-only (the step updates open rows); deleted after 120 days.
CREATE TABLE public.auction_outcomes (
  data_date date NOT NULL,
  domain text NOT NULL CHECK (domain = lower(domain)),
  "group" text NOT NULL CHECK ("group" IN ('shortlist', 'control')),
  rank integer,
  score numeric,
  max_bid_suggested_cents integer,
  first_price_cents integer NOT NULL CHECK (first_price_cents >= 0),
  end_time timestamptz NOT NULL,
  last_seen_price_cents integer,
  last_seen_bids integer,
  last_seen_at timestamptz,
  final boolean NOT NULL DEFAULT false,
  would_win boolean,
  PRIMARY KEY (data_date, domain)
);
CREATE INDEX auction_outcomes_open ON public.auction_outcomes (end_time) WHERE NOT final;

-- Down Migration
DROP TABLE public.auction_outcomes;
ALTER TABLE public.godaddy_auctions_live DROP COLUMN cpc_cents;
ALTER TABLE public.godaddy_auctions_live DROP COLUMN search_volume;
ALTER TABLE public.godaddy_auctions_live DROP COLUMN keyword_registrations;
ALTER TABLE public.godaddy_auctions_live DROP COLUMN developed_tlds;
ALTER TABLE public.godaddy_auctions_live DROP COLUMN exact_match_tlds;
ALTER TABLE public.settings ALTER COLUMN shortlist_renewal_cents SET DEFAULT 1100;
UPDATE public.settings SET shortlist_renewal_cents = 1100;
CREATE INDEX datasave_pool_domain ON public.datasave_pool (source, domain);
ALTER TABLE public.settings ALTER COLUMN datasave_pool_keep_days SET DEFAULT 3;
UPDATE public.settings SET datasave_pool_keep_days = 3;
ALTER TABLE public.settings DROP COLUMN closeout_expiry_collect_max;
