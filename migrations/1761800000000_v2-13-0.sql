-- Up Migration
-- v2.13.0 (CR-012): sibling method bt1@v3 on test sets, and records per domain (US trademark and history), reused by later screening runs.

-- bt1@v3: the check on test_sets.sibling_method was named by Postgres; replace it by name lookup.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.test_sets'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%sibling_method%' LOOP
    EXECUTE format('ALTER TABLE public.test_sets DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.test_sets ADD CONSTRAINT test_sets_sibling_method_check CHECK (sibling_method IN ('bt1@v1', 'bt1@v2', 'bt1@v3'));

-- A record about a name that is not tied to one screening run. Append-only: the newest fresh row of a kind is the one a run uses.
-- checked_at is when the human looked (the freshness clock); created_at is when the row was written.
CREATE TABLE public.domain_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tm_us', 'history')),
  record jsonb NOT NULL,
  checked_by text NOT NULL,
  checked_at timestamptz NOT NULL,
  evidence_url text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  audit_id text,
  source_run_id text REFERENCES public.screening_runs (id)
);
CREATE INDEX domain_records_lookup_idx ON public.domain_records (domain, kind, checked_at DESC, id DESC);
CREATE TRIGGER domain_records_append_only BEFORE DELETE OR UPDATE ON public.domain_records FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER domain_records_no_truncate BEFORE TRUNCATE ON public.domain_records FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.domain_records;
ALTER TABLE public.test_sets DROP CONSTRAINT test_sets_sibling_method_check;
ALTER TABLE public.test_sets ADD CONSTRAINT test_sets_sibling_method_check CHECK (sibling_method IN ('bt1@v1', 'bt1@v2'));
