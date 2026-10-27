-- Up Migration
-- v5.72.1: after CR-088 stores the whole auction field, paper trading keeps a fixed slice: the top shortlist_paper_n (25) names against a random control of the
-- same field (as before 5.72.0). The stored field is kept 30 days instead of 90 (about 750 rows a day on Neon's free plan).
ALTER TABLE public.settings ADD COLUMN shortlist_paper_n integer NOT NULL DEFAULT 25 CHECK (shortlist_paper_n BETWEEN 1 AND 1000);
UPDATE public.settings SET shortlist_keep_days = 30;

-- Down Migration
UPDATE public.settings SET shortlist_keep_days = 90;
ALTER TABLE public.settings DROP COLUMN shortlist_paper_n;
