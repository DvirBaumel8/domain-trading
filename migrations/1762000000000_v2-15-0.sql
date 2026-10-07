-- Up Migration
-- v2.15.0 (CR-013 R-4): retiring a forbidden term. Append-only: the term row stays; a retirement row says who, when and why.
CREATE TABLE public.forbidden_term_retirements (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_id integer NOT NULL UNIQUE REFERENCES public.forbidden_terms(id),
  at timestamptz NOT NULL DEFAULT now(),
  "by" text NOT NULL,
  audit_id text,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200)
);

CREATE TRIGGER forbidden_term_retirements_append_only BEFORE DELETE OR UPDATE ON public.forbidden_term_retirements FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER forbidden_term_retirements_no_truncate BEFORE TRUNCATE ON public.forbidden_term_retirements FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.forbidden_term_retirements;
