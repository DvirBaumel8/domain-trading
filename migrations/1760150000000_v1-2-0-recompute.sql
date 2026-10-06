-- Up Migration
-- v1.2.0 Task 3: same-run recompute of dependent checks. A stale automatic row is never edited: a new row is appended with a new
-- `generation`, a hash of `inputs` (the dependency row ids it was computed from, null = no row). A row is stale when the row in force
-- for any of its inputs differs. One automatic row per (run, item, check, generation), so two workers racing on the same recompute still write one row.
ALTER TABLE public.screening_results ADD COLUMN generation bigint NOT NULL DEFAULT 0;
ALTER TABLE public.screening_results ADD COLUMN inputs jsonb;
DROP INDEX public.screening_results_once;
CREATE UNIQUE INDEX screening_results_once ON public.screening_results (run_id, item_idx, check_id, generation) WHERE (source <> 'manual');

-- Down Migration
-- The old index allows one automatic row per (run, item, check); once a recompute has appended a second one it cannot be rebuilt.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.screening_results WHERE source <> 'manual' GROUP BY run_id, item_idx, check_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'cannot roll back: recomputed rows exist (several automatic rows per run, item and check)';
  END IF;
END $$;
DROP INDEX public.screening_results_once;
CREATE UNIQUE INDEX screening_results_once ON public.screening_results (run_id, item_idx, check_id) WHERE (source <> 'manual');
ALTER TABLE public.screening_results DROP COLUMN inputs;
ALTER TABLE public.screening_results DROP COLUMN generation;
