-- Up Migration
-- v5.53.0 (Dvir, 26 Oct 2026: "No need the outside review, remove it. We have it in another way."): the outside review (CR-011 part B) is removed,
-- so its six tables go. company_documents and forbidden_terms (the block list) stay.
-- The Down Migration restores the SCHEMA only (the original CREATE statements of v2.10.0, v2.11.2 and v3.1.0, with indexes and append-only triggers); the rows are NOT restored.
DROP TABLE public.review_retries;
DROP TABLE public.review_settings_changes;
DROP TABLE public.review_item_statuses;
DROP TABLE public.review_items;
DROP TABLE public.review_feedback;
DROP TABLE public.review_packets;

-- Down Migration
-- Schema only: the data of the dropped tables is gone.
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
-- v3.1.0
ALTER TABLE public.review_feedback ADD COLUMN attempts integer CHECK (attempts IS NULL OR attempts BETWEEN 1 AND 3);

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

-- v2.11.2
CREATE TABLE public.review_settings_changes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  "by" text NOT NULL,
  audit_id text,
  enabled boolean NOT NULL,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  tier text NOT NULL CHECK (tier IN ('free', 'paid')),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 300),
  old jsonb NOT NULL
);

CREATE TABLE public.review_retries (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  packet_id text NOT NULL UNIQUE REFERENCES public.review_packets(id),
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_retries_day_idx ON public.review_retries (day);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['review_packets', 'review_feedback', 'review_items', 'review_item_statuses', 'review_settings_changes', 'review_retries'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;
