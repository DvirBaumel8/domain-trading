-- Up Migration
-- v2.8.0 (CR-007 §22): drop lists (G-2 source A) and cohorts (G-1, the forward test).
-- Everything here is append-only except `cohorts`, whose only legal change is status computing -> frozen (guarded by a trigger).
-- All of it is business data and part of the nightly data export.

CREATE TABLE public.drop_lists (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  list_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  received_n integer NOT NULL CHECK (received_n >= 0),
  kept_n integer NOT NULL CHECK (kept_n >= 0)
);
CREATE TABLE public.drop_list_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_name text NOT NULL REFERENCES public.drop_lists(name),
  domain text NOT NULL,
  kept boolean NOT NULL,
  reason text,
  tokens text[]
);
CREATE INDEX drop_list_rows_list_idx ON public.drop_list_rows (list_name, id);
CREATE TABLE public.drop_list_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_name text NOT NULL REFERENCES public.drop_lists(name),
  domain text NOT NULL,
  checked_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_delete', 'redemption', 'registered', 'not_registered', 'unknown')),
  last_changed date,
  expected_drop_date date,
  drop_date_source text CHECK (drop_date_source IS NULL OR drop_date_source IN ('rdap_last_changed', 'estimate')),
  reason_code text
);
CREATE INDEX drop_list_checks_dom_idx ON public.drop_list_checks (domain, id);
CREATE INDEX drop_list_checks_list_idx ON public.drop_list_checks (list_name, domain, id);

CREATE TABLE public.cohorts (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  settings_labels text[] NOT NULL CHECK (cardinality(settings_labels) BETWEEN 1 AND 3),
  source jsonb NOT NULL,
  run_id text NOT NULL REFERENCES public.screening_runs(id),
  status text NOT NULL CHECK (status IN ('computing', 'frozen'))
);
CREATE TABLE public.cohort_names (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cohort text NOT NULL REFERENCES public.cohorts(name),
  domain text NOT NULL,
  expected_drop_date date,
  source text,
  included boolean NOT NULL,
  reason text
);
CREATE INDEX cohort_names_cohort_idx ON public.cohort_names (cohort, id);
CREATE INDEX cohort_names_domain_idx ON public.cohort_names (domain) WHERE included;
CREATE TABLE public.cohort_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cohort text NOT NULL REFERENCES public.cohorts(name),
  domain text NOT NULL,
  settings_label text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept', 'reject', 'undecided')),
  tier text,
  decided_at timestamptz NOT NULL,
  late boolean NOT NULL,
  UNIQUE (cohort, domain, settings_label)
);
CREATE TABLE public.cohort_outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cohort text NOT NULL REFERENCES public.cohorts(name),
  domain text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('drop', 'rereg30', 'rereg60', 'rereg90')),
  checked_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('available_after_drop', 'caught_at_drop', 'restored', 'still_pending', 'unknown', 'yes', 'no')),
  created_at_registry timestamptz,
  registrar text,
  reason_code text
);
CREATE INDEX cohort_outcomes_cohort_idx ON public.cohort_outcomes (cohort, domain, kind, id);

-- cohorts: never deleted; the one legal update is computing -> frozen with every other column unchanged.
CREATE FUNCTION public.cohorts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER cohorts_guard BEFORE DELETE OR UPDATE ON public.cohorts FOR EACH ROW EXECUTE FUNCTION public.cohorts_guard();
CREATE TRIGGER cohorts_no_truncate BEFORE TRUNCATE ON public.cohorts FOR EACH STATEMENT EXECUTE FUNCTION public.cohorts_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['drop_lists', 'drop_list_rows', 'drop_list_checks', 'cohort_names', 'cohort_decisions', 'cohort_outcomes'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Down Migration
DROP TABLE public.cohort_outcomes;
DROP TABLE public.cohort_decisions;
DROP TABLE public.cohort_names;
DROP TABLE public.cohorts;
DROP FUNCTION public.cohorts_guard();
DROP TABLE public.drop_list_checks;
DROP TABLE public.drop_list_rows;
DROP TABLE public.drop_lists;
