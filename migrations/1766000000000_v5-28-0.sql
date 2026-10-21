-- Up Migration
-- v5.28.0 (CR-073): pick-proof mechanics. A frozen daily pool, four arms (A = the Buyer's picks, B1, B2, C1 drawn by code), a seal, T30 labels, a report.
-- Backup: none of these tables is exported (backup-coverage test states the reason for each).

-- Settings (migration only). The bots can read them nowhere and change them nowhere; k can only go up (trigger below) and never past 300.
ALTER TABLE public.settings ADD COLUMN pickproof_k integer NOT NULL DEFAULT 100 CHECK (pickproof_k BETWEEN 1 AND 300);
ALTER TABLE public.settings ADD COLUMN pickproof_deadline_hour_utc integer NOT NULL DEFAULT 16 CHECK (pickproof_deadline_hour_utc BETWEEN 0 AND 23);
ALTER TABLE public.settings ADD COLUMN pickproof_pool_max_price_cents integer NOT NULL DEFAULT 4000 CHECK (pickproof_pool_max_price_cents > 0);
ALTER TABLE public.settings ADD COLUMN pickproof_labels_max_per_run integer NOT NULL DEFAULT 300 CHECK (pickproof_labels_max_per_run BETWEEN 0 AND 5000);
ALTER TABLE public.settings ADD COLUMN pickproof_pool_keep_days integer NOT NULL DEFAULT 45 CHECK (pickproof_pool_keep_days >= 1);

CREATE FUNCTION public.pickproof_k_raise_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pickproof_k < OLD.pickproof_k THEN
    RAISE EXCEPTION 'pickproof_k can only be raised (% -> %)', OLD.pickproof_k, NEW.pickproof_k USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settings_pickproof_k_raise_only BEFORE UPDATE OF pickproof_k ON public.settings FOR EACH ROW EXECUTE FUNCTION public.pickproof_k_raise_only();

-- One row per pick day D. pool_sha256 is over the frozen pool; seed = first 8 hex of it. sealed_at null = picks still open.
CREATE TABLE public.pickproof_days (
  day date PRIMARY KEY,
  data_date date NOT NULL,
  pool_sha256 text NOT NULL CHECK (pool_sha256 ~ '^[0-9a-f]{64}$'),
  seed bigint NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  k integer NOT NULL CHECK (k BETWEEN 1 AND 300),
  pool_n integer NOT NULL,
  sources jsonb NOT NULL,
  deadline timestamptz NOT NULL,
  arms jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz
);

-- The frozen pool (about 125,000 rows a day, kept pickproof_pool_keep_days; the sha stays in pickproof_days for good).
CREATE TABLE public.pickproof_pool (
  day date NOT NULL REFERENCES public.pickproof_days(day) ON DELETE CASCADE,
  domain text NOT NULL,
  source text NOT NULL,
  price_cents integer NOT NULL,
  passes_k1 boolean NOT NULL,
  is_two_word boolean NOT NULL,
  PRIMARY KEY (day, domain)
);

-- The arms (A as submitted, the others as drawn), in rank order; price_cents is copied so the report needs no pool.
CREATE TABLE public.pickproof_arms (
  day date NOT NULL REFERENCES public.pickproof_days(day),
  arm text NOT NULL CHECK (arm IN ('A', 'B1', 'B2', 'C1')),
  domain text NOT NULL,
  rank integer NOT NULL,
  price_cents integer NOT NULL,
  PRIMARY KEY (day, arm, domain)
);
CREATE INDEX pickproof_arms_domain_idx ON public.pickproof_arms (domain);

-- Every POST of picks, append-only.
CREATE TABLE public.pickproof_picks_history (
  id bigserial PRIMARY KEY,
  day date NOT NULL,
  names jsonb NOT NULL,
  n integer NOT NULL,
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER pickproof_picks_history_append_only BEFORE DELETE OR UPDATE ON public.pickproof_picks_history FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

-- T30 labels per (name, pick day), never per arm.
CREATE TABLE public.pickproof_labels (
  domain text NOT NULL,
  day date NOT NULL,
  label text NOT NULL CHECK (label IN ('taken', 'not_taken', 'unknown')),
  checked_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  created_at_rdap timestamptz,
  created_unknown boolean NOT NULL DEFAULT false,
  created_after_d boolean,
  statuses jsonb,
  reason text,
  PRIMARY KEY (domain, day)
);

-- A sealed day cannot change: not its row, not its arms.
CREATE FUNCTION public.pickproof_sealed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d date; s timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'pickproof_days' THEN
    IF OLD.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'pickproof day % is sealed', OLD.day; END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  d := COALESCE(NEW.day, OLD.day);
  SELECT sealed_at INTO s FROM public.pickproof_days WHERE day = d;
  IF s IS NOT NULL THEN RAISE EXCEPTION 'pickproof day % is sealed', d; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER pickproof_days_sealed BEFORE UPDATE OR DELETE ON public.pickproof_days FOR EACH ROW EXECUTE FUNCTION public.pickproof_sealed_guard();
CREATE TRIGGER pickproof_arms_sealed BEFORE INSERT OR UPDATE OR DELETE ON public.pickproof_arms FOR EACH ROW EXECUTE FUNCTION public.pickproof_sealed_guard();

-- Down Migration
DROP TABLE public.pickproof_labels;
DROP TABLE public.pickproof_picks_history;
DROP TABLE public.pickproof_arms;
DROP TABLE public.pickproof_pool;
DROP TABLE public.pickproof_days;
DROP FUNCTION public.pickproof_sealed_guard();
DROP TRIGGER settings_pickproof_k_raise_only ON public.settings;
DROP FUNCTION public.pickproof_k_raise_only();
ALTER TABLE public.settings DROP COLUMN pickproof_pool_keep_days;
ALTER TABLE public.settings DROP COLUMN pickproof_labels_max_per_run;
ALTER TABLE public.settings DROP COLUMN pickproof_pool_max_price_cents;
ALTER TABLE public.settings DROP COLUMN pickproof_deadline_hour_utc;
ALTER TABLE public.settings DROP COLUMN pickproof_k;
