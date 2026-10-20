-- Up Migration
-- v5.25.0 (CR-070): the forward-cost plan of a name. PUT /portfolio/{domain}/forward-costs appends a new plan version (a header row + its lines);
-- the newest version of a domain is its plan, older versions stay as history. Both tables are append-only (trigger). Backup: exported (backup-coverage test).
-- ledger_entries already allows the types tool, ai and adjustment (baseline CHECK), so POST /ledger/costs needs no schema change.
CREATE TABLE public.forward_cost_plans (
  id bigserial PRIMARY KEY,
  domain_id bigint NOT NULL REFERENCES public.domains (id),
  version integer NOT NULL CHECK (version >= 1),
  line_count integer NOT NULL CHECK (line_count >= 0),
  token_name text,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, version)
);
CREATE TABLE public.forward_cost_lines (
  id bigserial PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES public.forward_cost_plans (id),
  line_no integer NOT NULL CHECK (line_no >= 1),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  item text NOT NULL CHECK (char_length(item) BETWEEN 1 AND 200),
  planned_cents integer NOT NULL CHECK (planned_cents >= 0),
  basis text NOT NULL CHECK (char_length(basis) BETWEEN 1 AND 300),
  cost_type text NOT NULL CHECK (char_length(cost_type) BETWEEN 1 AND 60),
  UNIQUE (plan_id, line_no)
);
CREATE INDEX forward_cost_lines_month ON public.forward_cost_lines (month);
CREATE TRIGGER forward_cost_plans_append_only BEFORE DELETE OR UPDATE ON public.forward_cost_plans FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER forward_cost_plans_no_truncate BEFORE TRUNCATE ON public.forward_cost_plans FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER forward_cost_lines_append_only BEFORE DELETE OR UPDATE ON public.forward_cost_lines FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER forward_cost_lines_no_truncate BEFORE TRUNCATE ON public.forward_cost_lines FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- GET /market/matched (CR-075 follow-up): sets frozen with no positives came from test calls (a future as-of date); remove only those so a real set can be frozen.
-- The append-only trigger is switched off for this one statement.
ALTER TABLE public.market_matched_sets DISABLE TRIGGER market_matched_sets_append_only;
DELETE FROM public.market_matched_sets WHERE (payload->'summary'->>'positives_n')::int = 0;
ALTER TABLE public.market_matched_sets ENABLE TRIGGER market_matched_sets_append_only;

-- Down Migration
DROP TABLE public.forward_cost_lines;
DROP TABLE public.forward_cost_plans;
