-- Up Migration
-- v5.64.0 (CR-083): the card evidence cache. Buyer and Risk Gate post the result of their own USPTO / firm-screen checks once; both read it back
-- with a `fresh` flag (USPTO TTL 24 h, kill-list change). Bot-posted facts only: the service looks nothing up. Append-only (a correction is a new row
-- with `supersedes`). Not in the backup (bot evidence, re-postable; tests/modules/ops/unit/backup-coverage.test.ts).
CREATE TABLE public.card_evidence (
  id bigserial PRIMARY KEY,
  domain text CHECK (domain IS NULL OR (domain = lower(domain) AND domain ~ '^[a-z0-9-]+\.com$')),
  term text CHECK (term IS NULL OR (term = lower(term) AND char_length(term) BETWEEN 1 AND 200)),
  kind text NOT NULL CHECK (kind IN ('uspto_check', 'firm_screen', 'other')),
  verdict text NOT NULL CHECK (verdict IN ('kill', 'clear', 'flag', 'error', 'unknown')),
  checked_at timestamptz NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  evidence_ref text CHECK (evidence_ref IS NULL OR (char_length(evidence_ref) <= 500 AND position('@' in evidence_ref) = 0)),
  raw jsonb,
  supersedes bigint REFERENCES public.card_evidence (id),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (domain IS NOT NULL OR term IS NOT NULL)
);
CREATE INDEX card_evidence_domain_idx ON public.card_evidence (domain) WHERE domain IS NOT NULL;
CREATE INDEX card_evidence_term_idx ON public.card_evidence (term) WHERE term IS NOT NULL;
CREATE INDEX card_evidence_supersedes_idx ON public.card_evidence (supersedes) WHERE supersedes IS NOT NULL;

CREATE TRIGGER card_evidence_append_only BEFORE DELETE OR UPDATE ON public.card_evidence FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER card_evidence_no_truncate BEFORE TRUNCATE ON public.card_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.card_evidence;
