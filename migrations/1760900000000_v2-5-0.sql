-- Up Migration
-- v2.5.0 (CR-007 §21): test sets (a stored selection of names whose features DOM computes itself), and two optional columns on the
-- holdout suite definitions. test_sets keeps its status and seal fields up to date (not append-only; transitions are guarded in code);
-- test_set_rows is append-only. Both are part of the data backup.
CREATE TABLE public.test_sets (
  name text PRIMARY KEY CHECK (name ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
  purpose text NOT NULL CHECK (purpose IN ('new', 'rescore')),
  settings_label text,
  seed text,
  test_share numeric,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_id text NOT NULL REFERENCES public.screening_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('computing', 'ready', 'sealed')),
  sealed_at timestamptz,
  member_count integer,
  member_hash text CHECK (member_hash IS NULL OR member_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.test_set_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_name text NOT NULL REFERENCES public.test_sets(name),
  domain text NOT NULL,
  label text NOT NULL CHECK (label IN ('sold', 'dropped')),
  as_of date NOT NULL,
  source text NOT NULL,
  price_usd numeric,
  report_lane text CHECK (report_lane IN ('expired', 'fresh', 'aged', 'geo')),
  role text CHECK (role IN ('test', 'dev')),
  kept boolean NOT NULL,
  reason text
);
CREATE INDEX test_set_rows_set_idx ON public.test_set_rows (set_name);
CREATE INDEX test_set_rows_domain_idx ON public.test_set_rows (domain) WHERE kept;
CREATE TRIGGER test_set_rows_append_only BEFORE DELETE OR UPDATE ON public.test_set_rows FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER test_set_rows_no_truncate BEFORE TRUNCATE ON public.test_set_rows FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Suite definitions (existing rows: NULL = no gates left out, does not clear the hold).
ALTER TABLE public.holdout_suites ADD COLUMN gates_not_assessed text[] CHECK (gates_not_assessed <@ ARRAY['tm_us', 'tn', 'hist2', 'hist2_guard']::text[]);
ALTER TABLE public.holdout_suites ADD COLUMN clears_hold boolean;

-- Down Migration
ALTER TABLE public.holdout_suites DROP COLUMN clears_hold;
ALTER TABLE public.holdout_suites DROP COLUMN gates_not_assessed;
DROP TABLE public.test_set_rows;
DROP TABLE public.test_sets;
