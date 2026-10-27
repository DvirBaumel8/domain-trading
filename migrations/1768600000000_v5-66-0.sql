-- Up Migration
-- v5.66.0 (F47): the hand-registration paper test. Each week the bots submit a pool of unregistered .com names they considered and their picks from it;
-- DOM seals the picks with a same-size random control drawn from the rest of the pool; months later the names are labelled (taken by someone else? sold?).
-- No money, no buying, no AI. A sealed week and its names cannot change.
CREATE TABLE public.handreg_weeks (
  week date PRIMARY KEY,
  pool_n integer NOT NULL CHECK (pool_n > 0),
  pool_sha256 text NOT NULL,
  picks_n integer NOT NULL CHECK (picks_n > 0),
  seed bigint NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  control_sha256 text NOT NULL,
  submitted_by text NOT NULL,
  sealed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER handreg_weeks_immutable BEFORE UPDATE OR DELETE ON public.handreg_weeks FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TABLE public.handreg_names (
  week date NOT NULL REFERENCES public.handreg_weeks (week),
  domain text NOT NULL,
  arm text NOT NULL CHECK (arm IN ('pick', 'control')),
  rank integer NOT NULL CHECK (rank > 0),
  rdap_at_seal text NOT NULL CHECK (rdap_at_seal IN ('available', 'registered', 'unknown')),
  PRIMARY KEY (week, domain)
);
CREATE TRIGGER handreg_names_immutable BEFORE UPDATE OR DELETE ON public.handreg_names FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TABLE public.handreg_labels (
  week date NOT NULL,
  domain text NOT NULL,
  horizon text NOT NULL CHECK (horizon IN ('m6', 'm12')),
  label text NOT NULL CHECK (label IN ('taken', 'not_taken', 'unknown')),
  checked_at timestamptz NOT NULL,
  created_at_rdap timestamptz,
  reason text,
  attempts integer NOT NULL DEFAULT 1,
  PRIMARY KEY (week, domain, horizon),
  FOREIGN KEY (week, domain) REFERENCES public.handreg_names (week, domain)
);

-- Settings (migration only): the caps of a submission and of a label run.
ALTER TABLE public.settings ADD COLUMN handreg_max_pool integer NOT NULL DEFAULT 2000 CHECK (handreg_max_pool BETWEEN 10 AND 20000);
ALTER TABLE public.settings ADD COLUMN handreg_max_picks integer NOT NULL DEFAULT 30 CHECK (handreg_max_picks BETWEEN 1 AND 100);
ALTER TABLE public.settings ADD COLUMN handreg_labels_max_per_run integer NOT NULL DEFAULT 200 CHECK (handreg_labels_max_per_run BETWEEN 1 AND 2000);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN handreg_labels_max_per_run;
ALTER TABLE public.settings DROP COLUMN handreg_max_picks;
ALTER TABLE public.settings DROP COLUMN handreg_max_pool;
DROP TABLE public.handreg_labels;
DROP TABLE public.handreg_names;
DROP TABLE public.handreg_weeks;
