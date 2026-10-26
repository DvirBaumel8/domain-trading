-- Up Migration
-- v5.59.0 (CR-081): the historical replay replaces the pick-proof.
-- 1. settings.pickproof_enabled (default false): off = the datasave steps pickproofSeal / pickproofLabels report {status: off, reason: CR-081} and no new pick day is frozen
--    (no new pickproof_pool rows); the days already sealed stay readable.
-- 2. replay_day_runs: one row per replay of an archived day (POST /replay/runs). Named so as not to collide with the older selection `replay_runs` table.
ALTER TABLE public.settings ADD COLUMN pickproof_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE public.replay_day_runs (
  id bigserial PRIMARY KEY,
  date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('auctions', 'closeouts')),
  n integer NOT NULL CHECK (n BETWEEN 1 AND 200),
  seed text NOT NULL CHECK (length(seed) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'error')),
  report jsonb,
  error text,
  logic_version text,
  requested_by text,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX replay_day_runs_status_idx ON public.replay_day_runs (status, id);

-- Down Migration
DROP TABLE public.replay_day_runs;
ALTER TABLE public.settings DROP COLUMN pickproof_enabled;
