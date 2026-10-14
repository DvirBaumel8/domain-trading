-- Up Migration
-- v5.5.0 (CR-056 part 2): the scoring engine's model. engine_models keeps every trained version with its frozen test-set hash, metrics and parameters.
-- engine_endings also holds the .com's own registry facts (tld 'com'). A model training is a queue job `train` (one step, trainModel).
ALTER TABLE public.engine_endings DROP CONSTRAINT engine_endings_tld_check;
ALTER TABLE public.engine_endings ADD CONSTRAINT engine_endings_tld_check CHECK (tld IN ('net', 'co', 'org', 'io', 'ai', 'com'));

ALTER TABLE public.job_runs DROP CONSTRAINT job_runs_job_check;
ALTER TABLE public.job_runs ADD CONSTRAINT job_runs_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train'));
ALTER TABLE public.job_queue_runs DROP CONSTRAINT job_queue_runs_job_check;
ALTER TABLE public.job_queue_runs ADD CONSTRAINT job_queue_runs_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train'));
ALTER TABLE public.job_steps DROP CONSTRAINT job_steps_job_check;
ALTER TABLE public.job_steps ADD CONSTRAINT job_steps_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train'));

-- One row per training run. The id is eng-1.0.<n>. Status moves running -> done | failed once. `params` (bins, trees, logistic coefficients, tier model)
-- and `test_rows` (the frozen test set with its scores) are cleared by the next training for models older than the newest four, the rest stays for good.
CREATE TABLE public.engine_models (
  n bigserial NOT NULL UNIQUE,
  id text GENERATED ALWAYS AS ('eng-1.0.' || n::text) STORED PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error text,
  trained_by text NOT NULL,
  audit_id text,
  queue_run_id text,
  dataset jsonb,
  test_sha256 text CHECK (test_sha256 IS NULL OR test_sha256 ~ '^[0-9a-f]{64}$'),
  params jsonb,
  metrics jsonb,
  chosen_weighting text CHECK (chosen_weighting IS NULL OR chosen_weighting IN ('unweighted', 'half_life_12m')),
  feature_list jsonb,
  test_rows jsonb,
  CHECK (status <> 'done' OR (metrics IS NOT NULL AND test_sha256 IS NOT NULL AND chosen_weighting IS NOT NULL AND feature_list IS NOT NULL))
);
CREATE INDEX engine_models_status_idx ON public.engine_models (status, n DESC);

-- Down Migration
DROP TABLE public.engine_models;
ALTER TABLE public.job_steps DROP CONSTRAINT job_steps_job_check;
ALTER TABLE public.job_steps ADD CONSTRAINT job_steps_job_check CHECK (job IN ('tick', 'daily', 'screen')) NOT VALID;
ALTER TABLE public.job_queue_runs DROP CONSTRAINT job_queue_runs_job_check;
ALTER TABLE public.job_queue_runs ADD CONSTRAINT job_queue_runs_job_check CHECK (job IN ('tick', 'daily', 'screen')) NOT VALID;
ALTER TABLE public.job_runs DROP CONSTRAINT job_runs_job_check;
ALTER TABLE public.job_runs ADD CONSTRAINT job_runs_job_check CHECK (job IN ('tick', 'daily', 'screen')) NOT VALID;
DELETE FROM public.engine_endings WHERE tld = 'com';
ALTER TABLE public.engine_endings DROP CONSTRAINT engine_endings_tld_check;
ALTER TABLE public.engine_endings ADD CONSTRAINT engine_endings_tld_check CHECK (tld IN ('net', 'co', 'org', 'io', 'ai'));
