-- Up Migration
-- v5.13.0 (M15): POST /screening/runs/{id}/cancel and /selection/test-sets/{name}/cancel accepted `reason` and dropped it; keep it on the run.
ALTER TABLE public.screening_runs ADD COLUMN cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 200);

-- Down Migration
ALTER TABLE public.screening_runs DROP COLUMN cancel_reason;
