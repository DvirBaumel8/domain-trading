-- Up Migration
-- v5.63.0 (CR-084): the decisions store and the X-Caller audit field.
-- decisions: one row per company decision id (D-...). Append-only (a correction is a new id with `supersedes`). A pure record: nothing reads it to act.
CREATE TABLE public.decisions (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$'),
  decided_at timestamptz NOT NULL,
  decided_by text NOT NULL CHECK (char_length(decided_by) BETWEEN 1 AND 60),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  scope text CHECK (scope IS NULL OR scope ~ '^[a-z0-9_-]{1,40}$'),
  domains text[] CHECK (domains IS NULL OR cardinality(domains) BETWEEN 1 AND 50),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
  supersedes text REFERENCES public.decisions (id) DEFERRABLE INITIALLY DEFERRED,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  audit_id text
);
CREATE INDEX decisions_decided_at ON public.decisions (decided_at DESC, id);
CREATE INDEX decisions_supersedes ON public.decisions (supersedes) WHERE supersedes IS NOT NULL;
CREATE TRIGGER decisions_append_only BEFORE DELETE OR UPDATE ON public.decisions FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER decisions_no_truncate BEFORE TRUNCATE ON public.decisions FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- X-Caller: the optional request header naming the bot or DOM behind a shared token; logged, never a security check.
ALTER TABLE public.audit_log ADD COLUMN caller text;

-- Down Migration
ALTER TABLE public.audit_log DROP COLUMN caller;
DROP TABLE public.decisions;
