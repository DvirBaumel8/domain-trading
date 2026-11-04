-- Up Migration
-- v6.7.0 (CR-104): the three limits of the pre-run gate GET /auctions/preflight. Migration only (no API write). No new table: the route writes nothing.
ALTER TABLE public.settings ADD COLUMN preflight_max_digits integer NOT NULL DEFAULT 4 CHECK (preflight_max_digits BETWEEN 0 AND 20);
ALTER TABLE public.settings ADD COLUMN preflight_min_coverage_bp integer NOT NULL DEFAULT 9000 CHECK (preflight_min_coverage_bp BETWEEN 0 AND 10000);
ALTER TABLE public.settings ADD COLUMN preflight_max_age_hours integer NOT NULL DEFAULT 12 CHECK (preflight_max_age_hours BETWEEN 1 AND 168);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN preflight_max_age_hours;
ALTER TABLE public.settings DROP COLUMN preflight_min_coverage_bp;
ALTER TABLE public.settings DROP COLUMN preflight_max_digits;
