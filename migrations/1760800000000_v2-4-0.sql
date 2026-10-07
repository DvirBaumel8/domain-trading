-- Up Migration
-- v2.4.0 (CR-008): Dvir's one approval of a frozen sibling method version (bt1@v1). Append-only; part of the data backup.
CREATE TABLE public.sibling_method_approvals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  method text NOT NULL,
  pools_sha256 text NOT NULL CHECK (pools_sha256 ~ '^[0-9a-f]{64}$'),
  approval_text text NOT NULL,
  approval_at timestamptz NOT NULL,
  audit_id text,
  created_by text,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method, pools_sha256)
);
CREATE TRIGGER sibling_method_approvals_append_only BEFORE DELETE OR UPDATE ON public.sibling_method_approvals FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER sibling_method_approvals_no_truncate BEFORE TRUNCATE ON public.sibling_method_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.sibling_method_approvals;
