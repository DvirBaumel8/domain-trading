-- Up Migration
-- v5.61.0: Afternic's official seller API (22 Oct 2026). afternic_listings_daily = one read of every Afternic listing per UTC day (the daily step afternicSync, read-only toward Afternic).
-- Money is integer cents (Afternic's micro-USD / 10,000). Append per day: a second read the same day replaces that day's row.
CREATE TABLE public.afternic_listings_daily (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain text NOT NULL,
  day date NOT NULL,
  list_status text,
  bin_cents bigint,
  floor_cents bigint,
  min_offer_cents bigint,
  leasing_enabled boolean,
  max_lease_months integer,
  show_buynow boolean,
  show_lto boolean,
  show_offer boolean,
  intake_style text,
  hidden boolean,
  views integer,
  leads integer,
  updated_at_afternic timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT afternic_listings_daily_domain_day UNIQUE (domain, day)
);
CREATE INDEX afternic_listings_daily_day ON public.afternic_listings_daily (day DESC);

-- Dvir, 27 Oct 2026 ("implement all"): lease-to-own max period 16 -> 12 months (NameBio: 41% of finished lease-to-own deals were cancelled; longer terms cancel more).
ALTER TABLE public.settings ALTER COLUMN afternic_lease_months SET DEFAULT 12;
UPDATE public.settings SET afternic_lease_months = 12, updated_at = now();

-- Down Migration
UPDATE public.settings SET afternic_lease_months = 16, updated_at = now();
ALTER TABLE public.settings ALTER COLUMN afternic_lease_months SET DEFAULT 16;
DROP TABLE public.afternic_listings_daily;
