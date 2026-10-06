-- Up Migration
-- v1.2.0 Task 3: same-run recompute of dependent checks. A stale automatic row is never edited: a new row is appended with a new
-- `generation` (the id of the newest dependency row it was computed from; 0 for a first computation). One automatic row per
-- (run, item, check, generation), so two workers racing on the same recompute still write one row.
ALTER TABLE public.screening_results ADD COLUMN generation bigint NOT NULL DEFAULT 0;
DROP INDEX public.screening_results_once;
CREATE UNIQUE INDEX screening_results_once ON public.screening_results (run_id, item_idx, check_id, generation) WHERE (source <> 'manual');

-- Down Migration
DROP INDEX public.screening_results_once;
CREATE UNIQUE INDEX screening_results_once ON public.screening_results (run_id, item_idx, check_id) WHERE (source <> 'manual');
ALTER TABLE public.screening_results DROP COLUMN generation;
