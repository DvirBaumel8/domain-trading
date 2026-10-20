-- Up Migration
-- v5.23.0 (CR-075, data program v1): market episodes (one row per name x venue x listing episode), the add-only sale reports, the data-quality runs and the frozen matched sets.
-- Storage rule (CR-075 Q1): market_names holds only episodes that can be a positive or a matched negative: every reported sale at $500+, Dynadot $500+ Buy-Now
-- listings, Dynadot closed auctions and GoDaddy auction endings that reached $500. Nothing under $500 is stored. Backup: not exported (backup-coverage test).

-- POST /data/sales rows. Add-only (trigger): no update, no delete.
CREATE TABLE public.market_sales (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (name = lower(name) AND char_length(name) <= 253 AND name ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  venue text NOT NULL CHECK (venue = lower(venue) AND venue ~ '^[a-z0-9_.-]{1,40}$'),
  sale_price_cents bigint NOT NULL CHECK (sale_price_cents > 0),
  sale_date date NOT NULL,
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 120 AND lower(source) NOT LIKE '%namebio%'),
  source_url text CHECK (source_url IS NULL OR char_length(source_url) <= 500),
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C', 'D')),
  listing_type text NOT NULL DEFAULT 'bin' CHECK (listing_type IN ('bin', 'offer', 'auction', 'closeout')),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, venue, sale_date, source)
);
CREATE INDEX market_sales_name_idx ON public.market_sales (name);
CREATE TRIGGER market_sales_append_only BEFORE DELETE OR UPDATE ON public.market_sales FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER market_sales_no_truncate BEFORE TRUNCATE ON public.market_sales FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TABLE public.market_names (
  episode_id text PRIMARY KEY CHECK (episode_id ~ '^[0-9a-f]{40}$'),
  name text NOT NULL CHECK (name = lower(name)),
  sld text NOT NULL,
  tld text NOT NULL,
  venue text NOT NULL,
  listing_type text NOT NULL CHECK (listing_type IN ('bin', 'offer', 'auction', 'closeout')),
  list_price_cents_first bigint CHECK (list_price_cents_first IS NULL OR list_price_cents_first >= 0),
  list_price_cents_last bigint CHECK (list_price_cents_last IS NULL OR list_price_cents_last >= 0),
  price_changes integer NOT NULL DEFAULT 0 CHECK (price_changes >= 0),
  first_seen date NOT NULL,
  last_seen date NOT NULL,
  days_listed integer NOT NULL CHECK (days_listed >= 0),
  -- the number of sealed snapshot days the name was seen on in this episode (0 for an episode that exists only because a sale was reported)
  seen_days integer NOT NULL DEFAULT 0 CHECK (seen_days >= 0),
  sale_only boolean NOT NULL DEFAULT false,
  outcome text NOT NULL CHECK (outcome IN ('sold', 'unsold', 'unknown', 'delisted')),
  outcome_rule text NOT NULL,
  sale_price_cents bigint CHECK (sale_price_cents IS NULL OR sale_price_cents > 0),
  sale_date date,
  source text NOT NULL,
  source_url text,
  source_sha256 text,
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C', 'D')),
  -- the as-of date of any feature attached to the row (loaded by later programs; the episodes job never writes or clears it); the leakage check reads it
  feat_asof date,
  dup_group text,
  dup_sources text[],
  price_band text NOT NULL CHECK (price_band IN ('500-999', '1k-2.5k', '2.5k-5k', '5k-10k', '10k+')),
  sale_id bigint REFERENCES public.market_sales (id),
  derived_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_seen >= first_seen),
  CHECK ((outcome = 'sold') = (sale_price_cents IS NOT NULL AND sale_date IS NOT NULL))
);
CREATE INDEX market_names_name_venue ON public.market_names (name, venue);
CREATE INDEX market_names_outcome ON public.market_names (outcome, outcome_rule, price_band);
CREATE INDEX market_names_sale_date ON public.market_names (sale_date) WHERE outcome = 'sold';

-- the latest data-quality run is the one /health.dq_market and /report read
CREATE TABLE public.market_dq_runs (
  id bigserial PRIMARY KEY,
  checked_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'alert')),
  results jsonb NOT NULL
);
CREATE INDEX market_dq_runs_at ON public.market_dq_runs (checked_at DESC);

-- GET /market/matched: the first call for (asof, ratio, seed) stores the set; later calls return it unchanged (append-only)
CREATE TABLE public.market_matched_sets (
  asof date NOT NULL,
  ratio integer NOT NULL CHECK (ratio BETWEEN 1 AND 20),
  seed bigint NOT NULL CHECK (seed >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asof, ratio, seed)
);
CREATE TRIGGER market_matched_sets_append_only BEFORE DELETE OR UPDATE ON public.market_matched_sets FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER market_matched_sets_no_truncate BEFORE TRUNCATE ON public.market_matched_sets FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.market_matched_sets;
DROP TABLE public.market_dq_runs;
DROP TABLE public.market_names;
DROP TABLE public.market_sales;
