-- Up Migration
-- v4.1.0 (CR-050 part 1): the sibling scan. One row per domain per scan, append-only; GET reads the newest row.
-- No email address and no person name is stored: only the company name a page shows and the URL of its contact page.
CREATE TABLE public.sibling_scans (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain LIKE '%.com'),
  fetched_at timestamptz NOT NULL,
  settings_label text NOT NULL,
  siblings jsonb NOT NULL,
  lead_points jsonb NOT NULL,
  complete boolean NOT NULL,
  skipped_n integer NOT NULL DEFAULT 0 CHECK (skipped_n >= 0),
  upstream_calls integer NOT NULL CHECK (upstream_calls >= 0),
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sibling_scans_domain_idx ON public.sibling_scans (domain, id DESC);
CREATE TRIGGER sibling_scans_append_only BEFORE DELETE OR UPDATE ON public.sibling_scans FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER sibling_scans_no_truncate BEFORE TRUNCATE ON public.sibling_scans FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.sibling_scans;
