-- Up Migration
-- v5.80.0 (CR-099): a day the server sealed with LOW_COVERAGE (under 90% of its planned pages read, the rule in src/core/snapshot-coverage.ts) may take a
-- same-day top-up: rows, sha256, coverage, last_modified and updated_at may change. Its identity, seal time, status and origin never do. Every other sealed row stays frozen.
CREATE OR REPLACE FUNCTION public.snapshot_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- sealed: retention taking the raw file away
  IF TG_OP = 'UPDATE' AND NEW.raw_available = false AND OLD.raw_available = true AND NEW.raw_deleted_at IS NOT NULL
     AND (NEW.id, NEW.source, NEW.data_date, NEW.file_name, NEW.bytes, NEW.sha256, NEW.last_modified, NEW.rows, NEW.rows_total, NEW.status, NEW.http_status, NEW.error, NEW.sealed_at, NEW.created_at, NEW.origin, NEW.coverage)
         IS NOT DISTINCT FROM (OLD.id, OLD.source, OLD.data_date, OLD.file_name, OLD.bytes, OLD.sha256, OLD.last_modified, OLD.rows, OLD.rows_total, OLD.status, OLD.http_status, OLD.error, OLD.sealed_at, OLD.created_at, OLD.origin, OLD.coverage) THEN
    RETURN NEW;
  END IF;
  -- sealed by the server with LOW_COVERAGE: the top-up of the missing pages
  IF TG_OP = 'UPDATE' AND OLD.origin = 'server'
     AND jsonb_typeof(OLD.coverage->'pages_planned') = 'array' AND jsonb_typeof(OLD.coverage->'pages_ok') = 'array' AND jsonb_array_length(OLD.coverage->'pages_planned') > 0
     AND jsonb_array_length(OLD.coverage->'pages_ok')::numeric < 0.9 * jsonb_array_length(OLD.coverage->'pages_planned')
     AND (NEW.id, NEW.source, NEW.data_date, NEW.file_name, NEW.status, NEW.sealed_at, NEW.created_at, NEW.origin, NEW.raw_available)
         IS NOT DISTINCT FROM (OLD.id, OLD.source, OLD.data_date, OLD.file_name, OLD.status, OLD.sealed_at, OLD.created_at, OLD.origin, OLD.raw_available) THEN
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
     AND (NEW.id, NEW.source, NEW.data_date, NEW.file_name, NEW.bytes, NEW.sha256, NEW.last_modified, NEW.rows, NEW.rows_total, NEW.status, NEW.http_status, NEW.error, NEW.sealed_at, NEW.created_at, NEW.origin, NEW.coverage)
         IS NOT DISTINCT FROM (OLD.id, OLD.source, OLD.data_date, OLD.file_name, OLD.bytes, OLD.sha256, OLD.last_modified, OLD.rows, OLD.rows_total, OLD.status, OLD.http_status, OLD.error, OLD.sealed_at, OLD.created_at, OLD.origin, OLD.coverage) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sealed snapshot manifest %: % is not allowed', OLD.id, TG_OP;
END
$$;
