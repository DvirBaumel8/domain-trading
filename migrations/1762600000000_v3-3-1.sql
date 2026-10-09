-- Up Migration
-- v3.3.1 (CR-025): vendor test posts don't use the company's daily post allowance. DOM's own test posts are listed here (append-only),
-- only by a migration: there is no API to add a row, so no caller can free a slot. The first row is DOM's 2026-10-09 04:13 IDT test post.
CREATE TABLE public.post_allowance_exclusions (
  id bigserial PRIMARY KEY,
  post_id text NOT NULL UNIQUE REFERENCES public.posts(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER post_allowance_exclusions_append_only BEFORE DELETE OR UPDATE ON public.post_allowance_exclusions FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER post_allowance_exclusions_no_truncate BEFORE TRUNCATE ON public.post_allowance_exclusions FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
INSERT INTO public.post_allowance_exclusions (post_id, reason)
  SELECT id, 'DOM vendor test post after the v3.2.2 Buffer fix (CR-025)' FROM public.posts WHERE id = 'pst_c1eaba454a6a';

-- Down Migration
DROP TABLE public.post_allowance_exclusions;
