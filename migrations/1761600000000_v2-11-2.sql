-- Up Migration
-- v2.11.2 (CR-011 addendum C): the outside review's on/off switch, model and tier, and the 429 retry marker.
-- Both tables are append-only and business data in the nightly data export.

-- Current settings = the newest row; no row = the defaults {enabled true, model gemini-3.8-flash, tier free} (written in code).
-- `old` holds the settings before the change, so each row has the old and the new value.
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

-- A 429 from Google in the scheduled daily review stores no feedback; its packet gets one row here (the day is the IDT day).
-- The 10:30 IDT tick's reviewRetry step retries a packet that has a row for today and no feedback yet. The retry always ends with
-- feedback (ok or unknown), so "not yet retried" is simply "no feedback", and nothing here is ever updated.
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
  FOREACH t IN ARRAY ARRAY['review_settings_changes', 'review_retries'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Down Migration
DROP TABLE public.review_retries;
DROP TABLE public.review_settings_changes;
