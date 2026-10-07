-- Up Migration
-- v2.9.0 (CR-010 F-1, F-3): a running screening run or test set can be cancelled; every stored registry answer records which RDAP host answered.
ALTER TABLE public.screening_runs DROP CONSTRAINT screening_runs_status_check;
ALTER TABLE public.screening_runs ADD CONSTRAINT screening_runs_status_check CHECK (status IN ('running', 'done', 'partial', 'cancelled'));
ALTER TABLE public.screening_runs ADD COLUMN cancelled_at timestamptz;
ALTER TABLE public.screening_runs ADD COLUMN cancelled_by text;
ALTER TABLE public.test_sets DROP CONSTRAINT test_sets_status_check;
ALTER TABLE public.test_sets ADD CONSTRAINT test_sets_status_check CHECK (status IN ('computing', 'ready', 'sealed', 'cancelled'));
-- NULL on answers stored before v2.9.0.
ALTER TABLE public.rdap_lookups ADD COLUMN source text;

-- Down Migration
ALTER TABLE public.rdap_lookups DROP COLUMN source;
ALTER TABLE public.test_sets DROP CONSTRAINT test_sets_status_check;
ALTER TABLE public.test_sets ADD CONSTRAINT test_sets_status_check CHECK (status IN ('computing', 'ready', 'sealed'));
ALTER TABLE public.screening_runs DROP COLUMN cancelled_by;
ALTER TABLE public.screening_runs DROP COLUMN cancelled_at;
ALTER TABLE public.screening_runs DROP CONSTRAINT screening_runs_status_check;
ALTER TABLE public.screening_runs ADD CONSTRAINT screening_runs_status_check CHECK (status IN ('running', 'done', 'partial'));
