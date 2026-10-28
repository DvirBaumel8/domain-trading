-- Up Migration
-- v5.74.0: Dynadot aftermarket rows (about 377,000 a sealed day, about 100 MB) are kept datasave_aftermarket_keep_days (2) days in the database instead of
-- datasave_dynadot_keep_days (120); older days are written to the host's archive first (<ARCHIVE_DIR>/dynadot/<date>-aftermarket.jsonl.gz). The market
-- episodes fold each sealed day into the stored episodes, so they no longer need the old rows. Closed-auction rows keep the 120 days.
ALTER TABLE public.settings ADD COLUMN datasave_aftermarket_keep_days integer NOT NULL DEFAULT 2 CHECK (datasave_aftermarket_keep_days BETWEEN 2 AND 120);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN datasave_aftermarket_keep_days;
