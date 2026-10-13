-- Up Migration
-- v5.1.0 (G-95, Dvir 14 Oct 2026): daily data retention. The append-only tables the retention job prunes get their own trigger
-- function: a DELETE is allowed only inside a transaction that ran SET LOCAL app.retention = 'on' (the retention job, nowhere else).
-- UPDATE and TRUNCATE stay forbidden. Every other append-only table keeps reject_mutation() unchanged.
CREATE FUNCTION public.reject_mutation_except_retention() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.retention', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['screening_results', 'screening_evidence', 'candidate_screenings', 'sibling_scans', 'job_runs', 'registrar_state_checks'] LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation_except_retention()', t || '_append_only', t);
  END LOOP;
END $$;
