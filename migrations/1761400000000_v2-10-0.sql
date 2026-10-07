-- Up Migration
-- v2.10.0 (CR-011 part B): the company document, the block list's forbidden terms, review packets, review feedback and items.
-- Everything here is append-only (a status change is a new row in review_item_statuses) and business data in the nightly data export.
-- No LLM is called by the service: Gavriel calls the reviewer; these tables only hold what he sends.

CREATE TABLE public.company_documents (
  version integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Not unique: going back to an earlier text is a new version (the no-change check compares with the latest version only).
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  audit_id text
);
CREATE INDEX company_documents_sha_idx ON public.company_documents (sha256);

-- The term is internal: no route returns it.
CREATE TABLE public.forbidden_terms (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term text NOT NULL CHECK (length(term) BETWEEN 2 AND 200),
  category text NOT NULL DEFAULT 'listed_term' CHECK (category = 'listed_term'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

CREATE TABLE public.review_packets (
  id text PRIMARY KEY CHECK (id ~ '^rvp_[0-9a-f]{12}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  document_version integer NOT NULL REFERENCES public.company_documents(version),
  content jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX review_packets_kind_idx ON public.review_packets (kind, created_at);

CREATE TABLE public.review_feedback (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  packet_id text NOT NULL UNIQUE REFERENCES public.review_packets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'unknown')),
  provider text NOT NULL,
  model text,
  cost_usd numeric(10,4) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  reason text
);

CREATE TABLE public.review_items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  packet_id text NOT NULL REFERENCES public.review_packets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  text text NOT NULL,
  novelty text NOT NULL CHECK (novelty IN ('new', 'repeat')),
  repeats_item_id integer REFERENCES public.review_items(id),
  CHECK ((novelty = 'repeat') = (repeats_item_id IS NOT NULL))
);
CREATE INDEX review_items_cat_idx ON public.review_items (category, id);

CREATE TABLE public.review_item_statuses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id integer NOT NULL REFERENCES public.review_items(id),
  status text NOT NULL CHECK (status IN ('acted', 'rejected', 'watching')),
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  audit_id text
);
CREATE INDEX review_item_statuses_item_idx ON public.review_item_statuses (item_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_documents', 'forbidden_terms', 'review_packets', 'review_feedback', 'review_items', 'review_item_statuses'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Down Migration
DROP TABLE public.review_item_statuses;
DROP TABLE public.review_items;
DROP TABLE public.review_feedback;
DROP TABLE public.review_packets;
DROP TABLE public.forbidden_terms;
DROP TABLE public.company_documents;
