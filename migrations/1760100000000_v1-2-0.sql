-- Up Migration
-- v1.2.0 (CR-001 P1b): FLAG verdicts, screening packs, outreach lead verification with erasable personal data.
CREATE TABLE public.screening_verdicts (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.screening_runs(id),
  item_idx smallint NOT NULL,
  domain text NOT NULL,
  check_id text NOT NULL,
  result_id bigint NOT NULL REFERENCES public.screening_results(id),
  verdict text NOT NULL CHECK (verdict IN ('PASS', 'REJECT')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL,
  recorded_by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screening_verdicts_run_idx ON public.screening_verdicts (run_id, result_id);
CREATE TRIGGER screening_verdicts_append_only BEFORE DELETE OR UPDATE ON public.screening_verdicts FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER screening_verdicts_no_truncate BEFORE TRUNCATE ON public.screening_verdicts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.screening_verdicts;
