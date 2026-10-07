-- Up Migration
-- v2.7.0 (CR-010 T10-4): a test set records the age limit (days) for reusing stored registry answers. NULL on sets made before v2.7.0 (read as 7).
-- started_at / finished_at are not stored: GET derives them (test_sets.created_at, screening_runs.finished_at).
ALTER TABLE public.test_sets ADD COLUMN max_answer_age_days integer CHECK (max_answer_age_days BETWEEN 0 AND 30);

-- Down Migration
ALTER TABLE public.test_sets DROP COLUMN max_answer_age_days;
