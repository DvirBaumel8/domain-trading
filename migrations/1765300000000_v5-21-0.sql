-- Up Migration
-- v5.21.0 (CR-071): the `datasave` job (daily data saves), the write-once snapshot manifests, the parsed closeouts pool, the datasave settings.

-- the new job kind in the three job tables
ALTER TABLE public.job_runs DROP CONSTRAINT job_runs_job_check;
ALTER TABLE public.job_runs ADD CONSTRAINT job_runs_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train', 'datasave'));
ALTER TABLE public.job_queue_runs DROP CONSTRAINT job_queue_runs_job_check;
ALTER TABLE public.job_queue_runs ADD CONSTRAINT job_queue_runs_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train', 'datasave'));
ALTER TABLE public.job_steps DROP CONSTRAINT job_steps_job_check;
ALTER TABLE public.job_steps ADD CONSTRAINT job_steps_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train', 'datasave'));

-- a queued run may wait: the datasave retry runs 60 minutes after a failed GoDaddy step (the worker takes no step of the run before this time)
ALTER TABLE public.job_queue_runs ADD COLUMN not_before timestamptz;

-- settings of the job (migration only, like the other caps and ladders)
ALTER TABLE public.settings ADD COLUMN datasave_godaddy_files jsonb NOT NULL DEFAULT
  '["closeout_listings.json.zip","all_expiring_auctions.json.zip","all_biddable_auctions.json.zip","all_listings_ending_today.json.zip","auctions_ending_today.json.zip"]'::jsonb;
ALTER TABLE public.settings ADD COLUMN datasave_pool_max_price_cents integer NOT NULL DEFAULT 4000 CHECK (datasave_pool_max_price_cents > 0);
ALTER TABLE public.settings ADD COLUMN datasave_pool_keep_days integer NOT NULL DEFAULT 3 CHECK (datasave_pool_keep_days >= 2);
ALTER TABLE public.settings ADD COLUMN datasave_raw_keep_days integer NOT NULL DEFAULT 7 CHECK (datasave_raw_keep_days >= 1);

-- one row per saved file. A complete row is sealed (write-once); an error or partial row stays open so the retry can replace it.
CREATE TABLE public.snapshot_manifests (
  id bigserial PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('godaddy_inventory', 'dynadot_closeouts', 'dynadot_aftermarket')),
  data_date date NOT NULL,
  file_name text NOT NULL,
  bytes bigint,
  sha256 text,
  last_modified timestamptz,
  rows integer,
  rows_total integer,
  status text NOT NULL CHECK (status IN ('complete', 'partial', 'error', 'not_configured')),
  http_status integer,
  error text,
  raw_path text,
  raw_available boolean NOT NULL DEFAULT false,
  raw_note text,
  raw_deleted_at timestamptz,
  sealed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, data_date, file_name),
  CHECK (sealed_at IS NULL OR status = 'complete')
);
CREATE INDEX snapshot_manifests_source_date ON public.snapshot_manifests (source, data_date);

CREATE FUNCTION public.snapshot_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER snapshot_manifests_guard BEFORE DELETE OR UPDATE ON public.snapshot_manifests FOR EACH ROW EXECUTE FUNCTION public.snapshot_manifest_guard();

-- the parsed closeouts of the last few days (only .com names up to the price cap, not adult); score columns are for CR-072
CREATE TABLE public.datasave_pool (
  data_date date NOT NULL,
  source text NOT NULL,
  domain text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  ends_at timestamptz NOT NULL,
  score numeric,
  score_reason text,
  PRIMARY KEY (data_date, source, domain),
  CHECK (domain = lower(domain))
);
CREATE INDEX datasave_pool_domain ON public.datasave_pool (source, domain);

-- Down Migration
DROP TABLE public.datasave_pool;
DROP TRIGGER snapshot_manifests_guard ON public.snapshot_manifests;
DROP FUNCTION public.snapshot_manifest_guard();
DROP TABLE public.snapshot_manifests;
ALTER TABLE public.settings DROP COLUMN datasave_raw_keep_days;
ALTER TABLE public.settings DROP COLUMN datasave_pool_keep_days;
ALTER TABLE public.settings DROP COLUMN datasave_pool_max_price_cents;
ALTER TABLE public.settings DROP COLUMN datasave_godaddy_files;
ALTER TABLE public.job_queue_runs DROP COLUMN not_before;
DELETE FROM public.job_steps WHERE job = 'datasave';
DELETE FROM public.job_queue_runs WHERE job = 'datasave';
ALTER TABLE public.job_steps DROP CONSTRAINT job_steps_job_check;
ALTER TABLE public.job_steps ADD CONSTRAINT job_steps_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train'));
ALTER TABLE public.job_queue_runs DROP CONSTRAINT job_queue_runs_job_check;
ALTER TABLE public.job_queue_runs ADD CONSTRAINT job_queue_runs_job_check CHECK (job IN ('tick', 'daily', 'screen', 'train'));
-- job_runs is append-only: datasave rows stay, so its CHECK keeps 'datasave'
