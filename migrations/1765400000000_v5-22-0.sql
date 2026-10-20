-- Up Migration
-- v5.22.0 (CR-071 R-8..R-10): Dynadot rows uploaded by the bots, sealed like the GoDaddy files; GoDaddy auction endings (auctions that reached $500).

ALTER TABLE public.snapshot_manifests DROP CONSTRAINT snapshot_manifests_source_check;
ALTER TABLE public.snapshot_manifests ADD CONSTRAINT snapshot_manifests_source_check
  CHECK (source IN ('godaddy_inventory', 'dynadot_closeouts', 'dynadot_aftermarket', 'dynadot_closed_auctions'));
-- where the file came from: 'fetch' (the job) or 'bot_upload' (POST /snapshots/dynadot)
ALTER TABLE public.snapshot_manifests ADD COLUMN origin text NOT NULL DEFAULT 'fetch' CHECK (origin IN ('fetch', 'bot_upload'));

ALTER TABLE public.settings ADD COLUMN datasave_dynadot_keep_days integer NOT NULL DEFAULT 120 CHECK (datasave_dynadot_keep_days >= 2);
ALTER TABLE public.settings ADD COLUMN datasave_auction_keep_days integer NOT NULL DEFAULT 120 CHECK (datasave_auction_keep_days >= 2);

-- the rows of the bot uploads. aftermarket: unique per listing_id; closed_auctions and closeouts: unique per domain, per day.
CREATE TABLE public.dynadot_rows (
  id bigserial PRIMARY KEY,
  data_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('aftermarket', 'closed_auctions', 'closeouts')),
  domain text NOT NULL CHECK (domain = lower(domain)),
  listing_id text,
  price_cents integer CHECK (price_cents IS NULL OR price_cents >= 0),
  bid_count integer CHECK (bid_count IS NULL OR bid_count >= 0),
  end_time timestamptz,
  final_price_cents integer CHECK (final_price_cents IS NULL OR final_price_cents >= 0),
  ends_at timestamptz
);
CREATE UNIQUE INDEX dynadot_rows_listing ON public.dynadot_rows (data_date, kind, listing_id) WHERE kind = 'aftermarket';
CREATE UNIQUE INDEX dynadot_rows_domain ON public.dynadot_rows (data_date, kind, domain) WHERE kind <> 'aftermarket';
CREATE INDEX dynadot_rows_domain_lookup ON public.dynadot_rows (domain);

-- one row per GoDaddy auction that reached $500 (and is followed until it ends). At most one open row per domain.
CREATE TABLE public.godaddy_auctions (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain)),
  end_time timestamptz NOT NULL,
  auction_type text,
  first_seen date NOT NULL,
  last_seen date NOT NULL,
  last_price_cents integer NOT NULL CHECK (last_price_cents >= 0),
  max_price_cents integer NOT NULL CHECK (max_price_cents >= 0),
  last_bid_count integer NOT NULL DEFAULT 0 CHECK (last_bid_count >= 0),
  final_state_at date,
  ended boolean NOT NULL DEFAULT false,
  CHECK ((ended AND final_state_at IS NOT NULL) OR (NOT ended AND final_state_at IS NULL))
);
CREATE UNIQUE INDEX godaddy_auctions_open ON public.godaddy_auctions (domain) WHERE NOT ended;
CREATE INDEX godaddy_auctions_final ON public.godaddy_auctions (final_state_at) WHERE ended;

-- Down Migration
DROP TABLE public.godaddy_auctions;
DROP TABLE public.dynadot_rows;
ALTER TABLE public.settings DROP COLUMN datasave_auction_keep_days;
ALTER TABLE public.settings DROP COLUMN datasave_dynadot_keep_days;
DELETE FROM public.snapshot_manifests WHERE source = 'dynadot_closed_auctions';
ALTER TABLE public.snapshot_manifests DROP COLUMN origin;
ALTER TABLE public.snapshot_manifests DROP CONSTRAINT snapshot_manifests_source_check;
ALTER TABLE public.snapshot_manifests ADD CONSTRAINT snapshot_manifests_source_check
  CHECK (source IN ('godaddy_inventory', 'dynadot_closeouts', 'dynadot_aftermarket'));
