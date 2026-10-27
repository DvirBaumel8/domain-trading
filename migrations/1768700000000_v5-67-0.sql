-- Up Migration
-- v5.67.0: F47 removed (Dvir, 27 Oct 2026: declined, then "Yes" to removing the idle code). Drops what 1768600000000_v5-66-0.sql added; no rows were ever written.
DROP TABLE IF EXISTS public.handreg_labels;
DROP TABLE IF EXISTS public.handreg_names;
DROP TABLE IF EXISTS public.handreg_weeks;
ALTER TABLE public.settings DROP COLUMN IF EXISTS handreg_labels_max_per_run;
ALTER TABLE public.settings DROP COLUMN IF EXISTS handreg_max_picks;
ALTER TABLE public.settings DROP COLUMN IF EXISTS handreg_max_pool;

-- Down Migration
-- No down: re-run 1768600000000_v5-66-0.sql's up to restore the empty tables.
