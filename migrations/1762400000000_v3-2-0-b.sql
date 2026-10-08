-- Up Migration
-- v3.2.0 (CR-020 B): the scout's optional "who chases this kind of name" line, stored with the intake row (information only; it never affects scoring).
ALTER TABLE public.candidate_intake ADD COLUMN who_chases text CHECK (who_chases IS NULL OR char_length(who_chases) <= 300);

-- v3.2.0 (CR-018 A): a list rebuilt automatically when the day's intake screening run finishes is built_by 'auto' (it does not count toward the 6 manual rebuilds a day).
ALTER TABLE public.daily_candidate_lists DROP CONSTRAINT daily_candidate_lists_built_by_check;
ALTER TABLE public.daily_candidate_lists ADD CONSTRAINT daily_candidate_lists_built_by_check CHECK (built_by IN ('daily', 'rebuild', 'auto'));

-- Down Migration
-- the table is append-only: rows already built 'auto' stay, so the old rule is added NOT VALID
ALTER TABLE public.daily_candidate_lists DROP CONSTRAINT daily_candidate_lists_built_by_check;
ALTER TABLE public.daily_candidate_lists ADD CONSTRAINT daily_candidate_lists_built_by_check CHECK (built_by IN ('daily', 'rebuild')) NOT VALID;
ALTER TABLE public.candidate_intake DROP COLUMN who_chases;
