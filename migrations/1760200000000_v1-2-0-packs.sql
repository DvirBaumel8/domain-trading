-- Up Migration
-- v1.2.0 Task 4: the frozen, versioned screening pack (CAP-19). Append-only; a new version is a new row.
CREATE TABLE public.screening_packs (
  id text PRIMARY KEY CHECK (id ~ '^pk_[0-9a-f]{12}$'),
  domain text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  run_id text NOT NULL REFERENCES public.screening_runs(id),
  item_idx smallint NOT NULL,
  status text NOT NULL CHECK (status IN ('complete', 'incomplete')),
  missing jsonb NOT NULL,
  content jsonb NOT NULL,
  content_sha256 char(64) NOT NULL,
  settings_label text NOT NULL,
  issued_at timestamptz NOT NULL,
  issued_by text NOT NULL,
  audit_id text,
  UNIQUE (domain, version)
);
CREATE TRIGGER screening_packs_append_only BEFORE DELETE OR UPDATE ON public.screening_packs FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER screening_packs_no_truncate BEFORE TRUNCATE ON public.screening_packs FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.screening_packs;
