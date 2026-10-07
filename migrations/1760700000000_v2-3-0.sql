-- Up Migration
-- v2.3.0 (CR-007): who started a manual run, token expiry, the Web Risk monthly counter, and the daily portfolio checks.
ALTER TABLE public.job_runs ADD COLUMN triggered_by text;

ALTER TABLE public.api_tokens ADD COLUMN expires_at timestamptz;

-- Calls made to a metered outside source, per UTC calendar month ('YYYY-MM'). A counter, not a log: not append-only.
CREATE TABLE public.api_usage (
  source text NOT NULL,
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (source, month)
);

-- One row per daily/weekly check of a live name (registry, lander, blocklists). Append-only; not part of the data backup (like job_runs).
CREATE TABLE public.portfolio_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id bigint NOT NULL REFERENCES public.domains(id),
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('registry', 'web', 'blocklist')),
  status text NOT NULL CHECK (status IN ('ok', 'fail', 'unknown')),
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX portfolio_checks_domain_kind_idx ON public.portfolio_checks (domain_id, kind, id DESC);
CREATE TRIGGER portfolio_checks_append_only BEFORE DELETE OR UPDATE ON public.portfolio_checks FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER portfolio_checks_no_truncate BEFORE TRUNCATE ON public.portfolio_checks FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.portfolio_checks;
DROP TABLE public.api_usage;
ALTER TABLE public.api_tokens DROP COLUMN expires_at;
ALTER TABLE public.job_runs DROP COLUMN triggered_by;
