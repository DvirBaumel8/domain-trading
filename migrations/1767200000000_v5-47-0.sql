-- Up Migration
-- v5.47.0: storage (F18, F19), the lift model (F5), the suspect-hit count (F17). Rules: docs/internal/pickproof.md "Storage", closeouts.md "Closeout expiries", engine.md "Lift model", visits.md.

-- ---- F18: pickproof_pool. A sealed day needs only the names of its arms after `pickproof_pool_keep_days` days (the sha256 of the pool and of every arm stay in pickproof_days).
ALTER TABLE public.settings ALTER COLUMN pickproof_pool_keep_days SET DEFAULT 1;
UPDATE public.settings SET pickproof_pool_keep_days = 1;
-- Rewrite the table with only the rows that stay (TRUNCATE gives the disk back at once; a DELETE alone would keep the file at its size). Kept: every row of an unsealed day or of a
-- day not older than the keep window (today and yesterday), and the arm names of older sealed days.
CREATE TEMP TABLE pickproof_pool_keep ON COMMIT DROP AS
  SELECT p.* FROM public.pickproof_pool p JOIN public.pickproof_days d ON d.day = p.day
  WHERE d.sealed_at IS NULL OR p.day >= ((now() AT TIME ZONE 'utc')::date - 1)
     OR EXISTS (SELECT 1 FROM public.pickproof_arms a WHERE a.day = p.day AND a.domain = p.domain);
TRUNCATE public.pickproof_pool;
INSERT INTO public.pickproof_pool SELECT * FROM pickproof_pool_keep;

-- ---- F19: closeout_expiries. Rows of names the engine does not train on are removed (the collector now keeps regime names only); decided rows are deleted after a short keep.
ALTER TABLE public.settings ADD COLUMN closeout_expiry_keep_days integer NOT NULL DEFAULT 7 CHECK (closeout_expiry_keep_days BETWEEN 1 AND 120);
-- the shape part of the regime test (letters only, 6..20 characters); the word split is checked by the next daily run, which removes the unchecked rest
DELETE FROM public.closeout_expiries WHERE attempts = 0 AND NOT final AND NOT (split_part(domain, '.', 1) ~ '^[a-z]{6,20}$');

-- ---- F5: the trained lift tables (one row per training; the newest is current). Append-only.
CREATE TABLE public.lift_models (
  id bigserial PRIMARY KEY,
  version text NOT NULL,
  trained_at timestamptz NOT NULL DEFAULT now(),
  data_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('seed', 'blend')),
  sold_n integer NOT NULL CHECK (sold_n >= 0),
  unsold_n integer NOT NULL CHECK (unsold_n >= 0),
  seed_sold_n integer NOT NULL CHECK (seed_sold_n >= 0),
  seed_unsold_n integer NOT NULL CHECK (seed_unsold_n >= 0),
  seed_weight double precision NOT NULL CHECK (seed_weight >= 0 AND seed_weight <= 1),
  holdout_n integer NOT NULL DEFAULT 0 CHECK (holdout_n >= 0),
  auc double precision CHECK (auc IS NULL OR (auc >= 0 AND auc <= 1)),
  bins jsonb NOT NULL
);
CREATE TRIGGER lift_models_append_only BEFORE DELETE OR UPDATE ON public.lift_models FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER lift_models_no_truncate BEFORE TRUNCATE ON public.lift_models FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- ---- F17: hits the counter reads as scanners or repeats (not human, not plain bot); counted apart so the human count stays honest.
ALTER TABLE public.visit_daily ADD COLUMN suspect_hits integer NOT NULL DEFAULT 0 CHECK (suspect_hits >= 0);

-- Down Migration
ALTER TABLE public.visit_daily DROP COLUMN suspect_hits;
DROP TABLE public.lift_models;
ALTER TABLE public.settings DROP COLUMN closeout_expiry_keep_days;
ALTER TABLE public.settings ALTER COLUMN pickproof_pool_keep_days SET DEFAULT 45;
