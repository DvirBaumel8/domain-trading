-- Up Migration
-- v5.50.0 (improvement pass 26 Oct, P6 and P9). Rules: docs/internal/engine.md "Auction ends (middle class)", docs/contract/formats.md "Afternic bulk upload".

-- ---- P9 (Dvir, 25 Oct 2026: lease-to-own stays ON for all names, 16 months at most): the Afternic export prints Lease to Own Y / Max Lease Period / Show Lease to Own Option Y.
-- A name's own lto_max_months (override) still wins; a name whose BIN is under Afternic's lease minimum ($495) is exported without the lease. Migration only.
ALTER TABLE public.settings ADD COLUMN afternic_lease_to_own boolean NOT NULL DEFAULT true;
ALTER TABLE public.settings ADD COLUMN afternic_lease_months integer NOT NULL DEFAULT 16 CHECK (afternic_lease_months BETWEEN 1 AND 60);

-- ---- P6: the middle class of the engine labels. GoDaddy auctions that ended in our range under the "sold" line (settings.datasave_auction_min_cents, $100) with at least one bid.
-- Filled by the datasave step engineFeed from the last godaddy_auctions_live snapshot of each ended auction. engine_sales and engine_unsold are unchanged; nothing trains on this table yet.
-- band: opening = final price at most $1 (the opening bid took it), low = over $1 and under $25, mid = $25 up to the sold line.
CREATE TABLE public.engine_auction_ends (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+\.com$'),
  end_date date NOT NULL,
  final_price_cents integer NOT NULL CHECK (final_price_cents >= 0),
  bids integer NOT NULL CHECK (bids >= 1),
  band text NOT NULL CHECK (band IN ('opening', 'low', 'mid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, end_date)
);
CREATE INDEX engine_auction_ends_date_idx ON public.engine_auction_ends (end_date);
CREATE TRIGGER engine_auction_ends_append_only BEFORE DELETE OR UPDATE ON public.engine_auction_ends FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER engine_auction_ends_no_truncate BEFORE TRUNCATE ON public.engine_auction_ends FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.engine_auction_ends;
ALTER TABLE public.settings DROP COLUMN afternic_lease_months;
ALTER TABLE public.settings DROP COLUMN afternic_lease_to_own;
