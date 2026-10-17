-- Up Migration
-- v5.12.0 (CR-063): the data the bots load once instead of keeping CSV copies. domain_rdap (candidate pool only) and live_checks are
-- cache-like and pruned by the daily retention step; tm_kills and bigco_names are append-only (a correction is a new row with `supersedes`);
-- sales_comps holds graded comparable sales (the CR-061 holdout guard applies at load). Backup: not exported (tests/modules/ops/unit/backup-coverage.test.ts).
CREATE TABLE public.domain_rdap (
  id bigserial PRIMARY KEY,
  host text NOT NULL UNIQUE CHECK (host = lower(host) AND host ~ '^[a-z0-9-]+\.com$'),
  created timestamptz,
  expires timestamptz,
  registrar text CHECK (registrar IS NULL OR char_length(registrar) <= 200),
  reg boolean NOT NULL,
  checked_at timestamptz NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_rdap_checked_idx ON public.domain_rdap (checked_at);

CREATE TABLE public.live_checks (
  id bigserial PRIMARY KEY,
  host text NOT NULL CHECK (host = lower(host) AND host ~ '^[a-z0-9-]+\.com$'),
  source text NOT NULL CHECK (source IN ('live', 'livefail', 'cc')),
  label text CHECK (label IS NULL OR char_length(label) <= 200),
  park text CHECK (park IS NULL OR char_length(park) <= 200),
  checked_at timestamptz NOT NULL,
  value_json jsonb,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host, source, checked_at)
);
CREATE INDEX live_checks_checked_idx ON public.live_checks (source, checked_at);

CREATE TABLE public.tm_kills (
  id bigserial PRIMARY KEY,
  term text NOT NULL CHECK (char_length(term) BETWEEN 1 AND 200),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  source text CHECK (source IS NULL OR char_length(source) <= 200),
  raw jsonb,
  supersedes bigint REFERENCES public.tm_kills (id),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tm_kills_term_idx ON public.tm_kills (term);

CREATE TABLE public.bigco_names (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  source text CHECK (source IS NULL OR char_length(source) <= 200),
  raw jsonb,
  supersedes bigint REFERENCES public.bigco_names (id),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bigco_names_name_idx ON public.bigco_names (name);

CREATE TABLE public.sales_comps (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+\.com$'),
  sale_date date NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  tier text NOT NULL CHECK (tier IN ('T1', 'T2', 'T3', 'T4')),
  year_flag text CHECK (year_flag IS NULL OR char_length(year_flag) <= 60),
  sale_year integer NOT NULL CHECK (sale_year BETWEEN 2000 AND 2100),
  reg_date_at_sale text CHECK (reg_date_at_sale IS NULL OR char_length(reg_date_at_sale) <= 60),
  net_reg_at_sale text CHECK (net_reg_at_sale IS NULL OR char_length(net_reg_at_sale) <= 60),
  org_reg_at_sale text CHECK (org_reg_at_sale IS NULL OR char_length(org_reg_at_sale) <= 60),
  source_url text CHECK (source_url IS NULL OR char_length(source_url) <= 500),
  dup_sources text CHECK (dup_sources IS NULL OR char_length(dup_sources) <= 500),
  engine_sale_id bigint REFERENCES public.engine_sales (id),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, sale_date, price_cents)
);
CREATE INDEX sales_comps_date_idx ON public.sales_comps (sale_date);

CREATE TRIGGER tm_kills_append_only BEFORE DELETE OR UPDATE ON public.tm_kills FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER tm_kills_no_truncate BEFORE TRUNCATE ON public.tm_kills FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER bigco_names_append_only BEFORE DELETE OR UPDATE ON public.bigco_names FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER bigco_names_no_truncate BEFORE TRUNCATE ON public.bigco_names FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.sales_comps;
DROP TABLE public.bigco_names;
DROP TABLE public.tm_kills;
DROP TABLE public.live_checks;
DROP TABLE public.domain_rdap;
