-- Up Migration
-- v2.16.0 (tech debt A): a cohort whose feature run was cancelled or ended partial is 'abandoned': no decisions are written and it does not count as open.
-- The one legal update of cohorts is still from computing, to frozen or abandoned, with every other column unchanged.
ALTER TABLE public.cohorts DROP CONSTRAINT cohorts_status_check;
ALTER TABLE public.cohorts ADD CONSTRAINT cohorts_status_check CHECK (status IN ('computing', 'frozen', 'abandoned'));

CREATE OR REPLACE FUNCTION public.cohorts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'append-only table cohorts: % is not allowed', TG_OP;
  END IF;
  IF OLD.status = 'computing' AND NEW.status IN ('frozen', 'abandoned')
     AND NEW.name = OLD.name AND NEW.created_at = OLD.created_at AND NEW.created_by = OLD.created_by
     AND NEW.settings_labels = OLD.settings_labels AND NEW.source = OLD.source AND NEW.run_id = OLD.run_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table cohorts: only status computing -> frozen or abandoned may change';
END $$;

-- v2.16.0 (CR-015 I-4): how a daily list was built, so manual rebuilds can be counted (at most 6 per IDT day). Existing rows are the daily step's.
ALTER TABLE public.daily_candidate_lists ADD COLUMN built_by text NOT NULL DEFAULT 'daily' CHECK (built_by IN ('daily', 'rebuild'));

-- Down Migration
ALTER TABLE public.daily_candidate_lists DROP COLUMN built_by;
UPDATE public.cohorts SET status = 'frozen' WHERE status = 'abandoned';
ALTER TABLE public.cohorts DROP CONSTRAINT cohorts_status_check;
ALTER TABLE public.cohorts ADD CONSTRAINT cohorts_status_check CHECK (status IN ('computing', 'frozen'));
CREATE OR REPLACE FUNCTION public.cohorts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'append-only table cohorts: % is not allowed', TG_OP;
  END IF;
  IF OLD.status = 'computing' AND NEW.status = 'frozen'
     AND NEW.name = OLD.name AND NEW.created_at = OLD.created_at AND NEW.created_by = OLD.created_by
     AND NEW.settings_labels = OLD.settings_labels AND NEW.source = OLD.source AND NEW.run_id = OLD.run_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table cohorts: only status computing -> frozen may change';
END $$;
