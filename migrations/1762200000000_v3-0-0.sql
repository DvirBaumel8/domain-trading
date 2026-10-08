-- Up Migration
-- v3.0.0 (refactor R3): a small Postgres job queue. POST /jobs/run enqueues a run (job_queue_runs) and one job_steps row per step;
-- the in-process worker claims steps with FOR UPDATE SKIP LOCKED, in position order. job_runs stays the append-only record of a FINISHED run:
-- it is written once, when every step is terminal, and carries queue_run_id to link back.
CREATE TABLE public.job_queue_runs (
  id text PRIMARY KEY,
  job text NOT NULL CHECK (job IN ('tick', 'daily')),
  trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'cli')),
  scheduled_for timestamptz,
  triggered_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.job_steps (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.job_queue_runs (id),
  job text NOT NULL CHECK (job IN ('tick', 'daily')),
  step text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts >= 1),
  timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
  locked_by text,
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  ms integer,
  summary jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, position)
);
CREATE INDEX job_steps_status_run_position_idx ON public.job_steps (status, run_id, position);

-- Not append-only (a step changes status as it runs), but only forward: queued -> running -> done | failed | skipped,
-- running -> queued (a failed attempt with attempts left, or an expired lock), queued -> failed | skipped (cancel). A terminal step never changes again,
-- and the identity of a step (run, step, position, limits) never changes.
CREATE FUNCTION public.job_steps_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.run_id <> OLD.run_id OR NEW.job <> OLD.job OR NEW.step <> OLD.step OR NEW.position <> OLD.position
     OR NEW.max_attempts <> OLD.max_attempts OR NEW.timeout_ms <> OLD.timeout_ms THEN
    RAISE EXCEPTION 'job_steps: the identity of a step cannot change';
  END IF;
  IF NOT ((OLD.status = 'queued' AND NEW.status IN ('running', 'failed', 'skipped'))
       OR (OLD.status = 'running' AND NEW.status IN ('queued', 'done', 'failed', 'skipped'))) THEN
    RAISE EXCEPTION 'job_steps: transition % -> % is not allowed', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_steps_guard BEFORE UPDATE ON public.job_steps FOR EACH ROW EXECUTE FUNCTION public.job_steps_guard();

ALTER TABLE public.job_runs ADD COLUMN queue_run_id text;
CREATE UNIQUE INDEX job_runs_queue_run_id_idx ON public.job_runs (queue_run_id) WHERE queue_run_id IS NOT NULL;

-- Down Migration
DROP INDEX public.job_runs_queue_run_id_idx;
ALTER TABLE public.job_runs DROP COLUMN queue_run_id;
DROP TABLE public.job_steps;
DROP FUNCTION public.job_steps_guard();
DROP TABLE public.job_queue_runs;
