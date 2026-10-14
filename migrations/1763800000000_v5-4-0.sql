-- Up Migration
-- v5.4.0 (CR-056 part 1): the scoring engine's data. Sold names, unsold names, one row per upload, and the per-name registry facts of the
-- same name on five other endings. Nothing here is touched by the retention job. Backup: not exported (see tests/modules/ops/unit/backup-coverage.test.ts).
CREATE TABLE public.engine_uploads (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('sales', 'unsold')),
  received_n integer NOT NULL CHECK (received_n >= 0),
  accepted_n integer NOT NULL CHECK (accepted_n >= 0),
  duplicate_n integer NOT NULL CHECK (duplicate_n >= 0),
  rejected_n integer NOT NULL CHECK (rejected_n >= 0),
  rejects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rejects) = 'array' AND jsonb_array_length(rejects) <= 200),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted_n + duplicate_n + rejected_n = received_n)
);
CREATE INDEX engine_uploads_kind_idx ON public.engine_uploads (kind, id DESC);

CREATE TABLE public.engine_sales (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+\.com$'),
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  sale_date date NOT NULL,
  venue text NOT NULL CHECK (char_length(venue) BETWEEN 1 AND 60),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 200),
  source_url text CHECK (source_url IS NULL OR char_length(source_url) <= 500),
  upload_id bigint NOT NULL REFERENCES public.engine_uploads (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_sales_domain_idx ON public.engine_sales (domain, sale_date);
CREATE INDEX engine_sales_date_idx ON public.engine_sales (sale_date);

CREATE TABLE public.engine_unsold (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+\.com$'),
  type text NOT NULL CHECK (type IN ('dropped_after_held', 'registered_unsold')),
  observation_date date NOT NULL,
  caught_by_catcher boolean,
  upload_id bigint NOT NULL REFERENCES public.engine_uploads (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, observation_date)
);
CREATE INDEX engine_unsold_date_idx ON public.engine_unsold (observation_date);

-- Registry facts per name (the part before .com) and ending. The newest row of a (name, tld) is current. A row with registered NULL is an
-- unanswered ask (reason_code says why); the fill job updates such a row when it asks again, and never changes a row that has an answer.
CREATE TABLE public.engine_endings (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (name = lower(name) AND name ~ '^[a-z0-9-]+$'),
  tld text NOT NULL CHECK (tld IN ('net', 'co', 'org', 'io', 'ai')),
  registered boolean,
  created_at_registry timestamptz,
  checked_at timestamptz NOT NULL,
  http_status integer,
  reason_code text,
  evidence jsonb,
  CHECK (registered IS NOT NULL OR (created_at_registry IS NULL AND reason_code IS NOT NULL)),
  CHECK (registered IS TRUE OR created_at_registry IS NULL)
);
CREATE INDEX engine_endings_name_tld_idx ON public.engine_endings (name, tld, checked_at DESC, id DESC);

CREATE TRIGGER engine_uploads_append_only BEFORE DELETE OR UPDATE ON public.engine_uploads FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER engine_uploads_no_truncate BEFORE TRUNCATE ON public.engine_uploads FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER engine_sales_append_only BEFORE DELETE OR UPDATE ON public.engine_sales FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER engine_sales_no_truncate BEFORE TRUNCATE ON public.engine_sales FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER engine_unsold_append_only BEFORE DELETE OR UPDATE ON public.engine_unsold FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER engine_unsold_no_truncate BEFORE TRUNCATE ON public.engine_unsold FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.engine_endings;
DROP TABLE public.engine_unsold;
DROP TABLE public.engine_sales;
DROP TABLE public.engine_uploads;
