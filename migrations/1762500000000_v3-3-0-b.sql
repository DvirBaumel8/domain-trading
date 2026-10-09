-- Up Migration
-- v3.3.0 part B (CR-023 B): the scout's list of firms that already sell the service ("sellers"), on the intake row, and as a record kind per domain.

ALTER TABLE public.candidate_intake ADD COLUMN sellers jsonb CHECK (sellers IS NULL OR (jsonb_typeof(sellers) = 'array' AND jsonb_array_length(sellers) <= 10));

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.domain_records'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE public.domain_records DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.domain_records ADD CONSTRAINT domain_records_kind_check CHECK (kind IN ('tm_us', 'history', 'sellers'));

-- Down Migration
-- the table is append-only: rows already of kind 'sellers' stay, so the old rule is added NOT VALID
ALTER TABLE public.domain_records DROP CONSTRAINT domain_records_kind_check;
ALTER TABLE public.domain_records ADD CONSTRAINT domain_records_kind_check CHECK (kind IN ('tm_us', 'history')) NOT VALID;
ALTER TABLE public.candidate_intake DROP COLUMN sellers;
