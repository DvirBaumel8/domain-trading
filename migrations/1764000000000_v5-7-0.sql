-- Up Migration
-- v5.7.0 (CR-058): the owned-name endings watch. engine_endings gets the registrar's name (from the RDAP registrar entity, null when the registry gives none);
-- owned_ending_events is the append-only baseline and change log of the five other endings of every owned .com.
ALTER TABLE public.engine_endings ADD COLUMN registrar text;

CREATE TABLE public.owned_ending_events (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+\.com$'),
  tld text NOT NULL CHECK (tld IN ('net', 'co', 'org', 'io', 'ai')),
  kind text NOT NULL CHECK (kind IN ('baseline', 'newly_registered', 're_registered')),
  registered boolean NOT NULL,
  created_at_registry timestamptz,
  registrar text,
  ending_id bigint REFERENCES public.engine_endings (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (registered IS TRUE OR created_at_registry IS NULL)
);
CREATE INDEX owned_ending_events_pair_idx ON public.owned_ending_events (domain, tld, id DESC);
CREATE INDEX owned_ending_events_recent_idx ON public.owned_ending_events (created_at DESC) WHERE kind <> 'baseline';

CREATE TRIGGER owned_ending_events_append_only BEFORE DELETE OR UPDATE ON public.owned_ending_events FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER owned_ending_events_no_truncate BEFORE TRUNCATE ON public.owned_ending_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.owned_ending_events;
ALTER TABLE public.engine_endings DROP COLUMN registrar;
