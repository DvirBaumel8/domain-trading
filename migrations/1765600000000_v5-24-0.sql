-- Up Migration
-- v5.24.0 (CR-071 R-8b): a bot upload's pull coverage on its manifest. The seal guard now also freezes origin and coverage.
ALTER TABLE public.snapshot_manifests ADD COLUMN coverage jsonb;
CREATE OR REPLACE FUNCTION public.snapshot_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- sealed: the only later change is retention taking the raw file away
  IF TG_OP = 'UPDATE' AND NEW.raw_available = false AND OLD.raw_available = true AND NEW.raw_deleted_at IS NOT NULL
     AND (NEW.id, NEW.source, NEW.data_date, NEW.file_name, NEW.bytes, NEW.sha256, NEW.last_modified, NEW.rows, NEW.rows_total, NEW.status, NEW.http_status, NEW.error, NEW.sealed_at, NEW.created_at, NEW.origin, NEW.coverage)
         IS NOT DISTINCT FROM (OLD.id, OLD.source, OLD.data_date, OLD.file_name, OLD.bytes, OLD.sha256, OLD.last_modified, OLD.rows, OLD.rows_total, OLD.status, OLD.http_status, OLD.error, OLD.sealed_at, OLD.created_at, OLD.origin, OLD.coverage) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sealed snapshot manifest %: % is not allowed', OLD.id, TG_OP;
END
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION public.snapshot_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- sealed: the only later change is retention taking the raw file away
  IF TG_OP = 'UPDATE' AND NEW.raw_available = false AND OLD.raw_available = true AND NEW.raw_deleted_at IS NOT NULL
     AND (NEW.id, NEW.source, NEW.data_date, NEW.file_name, NEW.bytes, NEW.sha256, NEW.last_modified, NEW.rows, NEW.rows_total, NEW.status, NEW.http_status, NEW.error, NEW.sealed_at, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.source, OLD.data_date, OLD.file_name, OLD.bytes, OLD.sha256, OLD.last_modified, OLD.rows, OLD.rows_total, OLD.status, OLD.http_status, OLD.error, OLD.sealed_at, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sealed snapshot manifest %: % is not allowed', OLD.id, TG_OP;
END
$$;
ALTER TABLE public.snapshot_manifests DROP COLUMN coverage;
