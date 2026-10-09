-- Up Migration
-- v3.3.0 part A (CR-021, CR-022 A).
-- CR-021: on-demand screening. A screening of `POST /candidates/screen` is a queue job `screen` (steps onDemandScreen, buildDailyList). Its names carry
-- `on_demand` on their candidate_screenings row, so the daily intake run's own count of 30 a day never includes them (and the on-demand allowance counts only them).
-- `params` holds the run's request (for `screen`: {max_names}).
ALTER TABLE public.job_runs DROP CONSTRAINT job_runs_job_check;
ALTER TABLE public.job_runs ADD CONSTRAINT job_runs_job_check CHECK (job IN ('tick', 'daily', 'screen'));
ALTER TABLE public.job_queue_runs DROP CONSTRAINT job_queue_runs_job_check;
ALTER TABLE public.job_queue_runs ADD CONSTRAINT job_queue_runs_job_check CHECK (job IN ('tick', 'daily', 'screen'));
ALTER TABLE public.job_steps DROP CONSTRAINT job_steps_job_check;
ALTER TABLE public.job_steps ADD CONSTRAINT job_steps_job_check CHECK (job IN ('tick', 'daily', 'screen'));
ALTER TABLE public.job_queue_runs ADD COLUMN params jsonb;
ALTER TABLE public.candidate_screenings ADD COLUMN on_demand boolean NOT NULL DEFAULT false;

-- CR-022 A: the scout's word pieces for the name (used instead of the dictionary split for that name); null = the dictionary split decided.
ALTER TABLE public.candidate_intake ADD COLUMN words text[] CHECK (words IS NULL OR (cardinality(words) BETWEEN 1 AND 6));

-- Down Migration
-- job_runs is append-only: rows already written by a `screen` run stay, so the old rule is added NOT VALID
ALTER TABLE public.candidate_intake DROP COLUMN words;
ALTER TABLE public.candidate_screenings DROP COLUMN on_demand;
ALTER TABLE public.job_queue_runs DROP COLUMN params;
ALTER TABLE public.job_steps DROP CONSTRAINT job_steps_job_check;
ALTER TABLE public.job_steps ADD CONSTRAINT job_steps_job_check CHECK (job IN ('tick', 'daily')) NOT VALID;
ALTER TABLE public.job_queue_runs DROP CONSTRAINT job_queue_runs_job_check;
ALTER TABLE public.job_queue_runs ADD CONSTRAINT job_queue_runs_job_check CHECK (job IN ('tick', 'daily')) NOT VALID;
ALTER TABLE public.job_runs DROP CONSTRAINT job_runs_job_check;
ALTER TABLE public.job_runs ADD CONSTRAINT job_runs_job_check CHECK (job IN ('tick', 'daily')) NOT VALID;
