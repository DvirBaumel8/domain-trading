-- Up Migration
-- v2.1.0 Part 2 (CR-005 N-1): the step summaries of every job run, kept durably. audit_log holds only a one-line summary and the
-- request, so the full result of each run needs its own small append-only table (one row per run, written when the run ends).
CREATE TABLE public.job_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job text NOT NULL CHECK (job IN ('tick', 'daily')),
  trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'cli')),
  scheduled_for timestamptz,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  skipped boolean NOT NULL,
  ok boolean NOT NULL,
  steps json NOT NULL -- json, not jsonb: the steps keep their run order
);
CREATE INDEX job_runs_job_finished_idx ON public.job_runs (job, finished_at DESC);
CREATE TRIGGER job_runs_append_only BEFORE DELETE OR UPDATE ON public.job_runs FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER job_runs_no_truncate BEFORE TRUNCATE ON public.job_runs FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.job_runs;
