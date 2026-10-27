-- Up Migration
-- v5.72.0 (CR-088): store the full hard-filter auction field, not just shortlist_size.
-- shortlist_size = 0 means "store all passers" (the new default); the old CHECK (1..100) is replaced.
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_shortlist_size_check;
ALTER TABLE public.settings ADD CONSTRAINT settings_shortlist_size_check CHECK (shortlist_size >= 0 AND shortlist_size <= 100000);
ALTER TABLE public.settings ALTER COLUMN shortlist_size SET DEFAULT 0;
UPDATE public.settings SET shortlist_size = 0 WHERE shortlist_size = 25;

-- Down Migration
UPDATE public.settings SET shortlist_size = 25 WHERE shortlist_size = 0;
ALTER TABLE public.settings ALTER COLUMN shortlist_size SET DEFAULT 25;
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_shortlist_size_check;
ALTER TABLE public.settings ADD CONSTRAINT settings_shortlist_size_check CHECK (shortlist_size >= 1 AND shortlist_size <= 100);
