-- Up Migration
-- v2.14.0 (CR-012 parts B and C): the token scope `intake`, scout intake, the screening of intake and drop-list names, and the daily candidate list.

ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write', 'intake'));
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'intake', 'admin', 'job'));

-- One row per name a scout sent (also the duplicates and the removed ones, so every extra source is on record). Append-only.
CREATE TABLE public.candidate_intake (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain text NOT NULL,
  lane text NOT NULL CHECK (lane IN ('S2', 'S3', 'S4', 'S6', 'S7')),
  source text NOT NULL,
  note text,
  comps jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  token_name text NOT NULL,
  audit_id text,
  status text NOT NULL CHECK (status IN ('queued', 'duplicate', 'removed')),
  reason text
);
CREATE INDEX candidate_intake_domain_idx ON public.candidate_intake (domain, id);
CREATE INDEX candidate_intake_status_idx ON public.candidate_intake (status, received_at, id);

-- A name taken into a daily screening run (an intake row, or a drop-list name with intake_id null). Append-only.
CREATE TABLE public.candidate_screenings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intake_id bigint REFERENCES public.candidate_intake (id),
  domain text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('intake', 'drop_list')),
  run_id text NOT NULL REFERENCES public.screening_runs (id),
  day date NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX candidate_screenings_domain_idx ON public.candidate_screenings (domain, id);
CREATE INDEX candidate_screenings_intake_idx ON public.candidate_screenings (intake_id);
CREATE INDEX candidate_screenings_run_idx ON public.candidate_screenings (run_id);

-- The daily candidate list, built once per IDT day (a later build appends a new version). Append-only.
CREATE TABLE public.daily_candidate_lists (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day date NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  entries jsonb NOT NULL,
  sections jsonb NOT NULL,
  summary jsonb NOT NULL
);
CREATE INDEX daily_candidate_lists_day_idx ON public.daily_candidate_lists (day, id DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['candidate_intake', 'candidate_screenings', 'daily_candidate_lists'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Down Migration
DROP TABLE public.daily_candidate_lists;
DROP TABLE public.candidate_screenings;
DROP TABLE public.candidate_intake;
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'admin', 'job'));
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write'));
