-- Up Migration
-- v5.14.0 (tech-debt R3, DB efficiency and growth).

-- D1: indexes. Plain CREATE INDEX is fine at this size (the live database is well under 1 GB).
-- Every run_id lookup (retention, report, replay, hold steps) had no non-partial index on screening_results.run_id.
CREATE INDEX IF NOT EXISTS screening_results_run_item ON public.screening_results (run_id, item_idx);
CREATE INDEX IF NOT EXISTS screening_results_cached_from ON public.screening_results (cached_from) WHERE cached_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS screening_packs_run ON public.screening_packs (run_id);
CREATE INDEX IF NOT EXISTS domain_records_source_run ON public.domain_records (source_run_id) WHERE source_run_id IS NOT NULL;
-- drop-list window reads and the dropWatch join look a (list, domain) up among the kept rows only
CREATE INDEX IF NOT EXISTS drop_list_rows_kept_list_domain ON public.drop_list_rows (list_name, domain) WHERE kept;
CREATE INDEX IF NOT EXISTS drop_list_rows_kept_domain ON public.drop_list_rows (domain) WHERE kept;
CREATE INDEX IF NOT EXISTS audit_log_path_at ON public.audit_log (path, at DESC);
-- latestScreeningRun (buy hold, pack gate): "a run lists the name in its input" was a scan of every run's input.
-- A GIN jsonb_path_ops index is the smaller choice (one hash per path/value, no second copy of the names, no backfill, covers every writer of screening_runs).
CREATE INDEX IF NOT EXISTS screening_runs_input_names ON public.screening_runs USING gin (input jsonb_path_ops);

-- D3: the retention step (src/modules/ops/jobs/retention.ts) now also prunes these append-only tables. Same carve-out as migration 1763500000000:
-- a DELETE is allowed only inside a transaction that ran SET LOCAL app.retention = 'on'; UPDATE and TRUNCATE stay forbidden.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['drop_list_checks', 'drop_list_rows', 'drop_lists', 'daily_candidate_lists', 'listing_sync_log'] LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation_except_retention()', t || '_append_only', t);
  END LOOP;
END $$;

-- D4: engine_endings used to append a row at every 30-day re-ask even when the answer was the same; since 5.14.0 the row is updated in place.
-- One-off cleanup: of consecutive identical answers (same registered and registry creation date) per (name, tld) keep only the newest.
-- A row an owned_ending_events row points to stays.
DELETE FROM public.engine_endings e
USING (
  SELECT id,
         registered IS NOT NULL
           AND registered IS NOT DISTINCT FROM lead(registered) OVER w
           AND created_at_registry IS NOT DISTINCT FROM lead(created_at_registry) OVER w AS superseded
  FROM public.engine_endings
  WINDOW w AS (PARTITION BY name, tld ORDER BY checked_at, id)
) s
WHERE e.id = s.id AND s.superseded
  AND NOT EXISTS (SELECT 1 FROM public.owned_ending_events o WHERE o.ending_id = e.id);

-- Down Migration
DROP INDEX IF EXISTS public.screening_runs_input_names;
DROP INDEX IF EXISTS public.audit_log_path_at;
DROP INDEX IF EXISTS public.drop_list_rows_kept_domain;
DROP INDEX IF EXISTS public.drop_list_rows_kept_list_domain;
DROP INDEX IF EXISTS public.domain_records_source_run;
DROP INDEX IF EXISTS public.screening_packs_run;
DROP INDEX IF EXISTS public.screening_results_cached_from;
DROP INDEX IF EXISTS public.screening_results_run_item;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['drop_list_checks', 'drop_list_rows', 'drop_lists', 'daily_candidate_lists', 'listing_sync_log'] LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
  END LOOP;
END $$;
