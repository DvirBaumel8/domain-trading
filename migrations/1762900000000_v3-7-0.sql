-- Up Migration
-- v3.7.0 (CR-033 G-6): the latest registrar-side state of a name (auto-renew, privacy, nameservers), one row per daily check. Append-only.
CREATE TABLE public.registrar_state_checks (
  id bigserial PRIMARY KEY,
  domain text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  auto_renew boolean,
  privacy boolean,
  ns text[]
);
CREATE INDEX registrar_state_checks_domain_idx ON public.registrar_state_checks (domain, id DESC);
CREATE TRIGGER registrar_state_checks_append_only BEFORE DELETE OR UPDATE ON public.registrar_state_checks FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER registrar_state_checks_no_truncate BEFORE TRUNCATE ON public.registrar_state_checks FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- v3.7.0 (CR-031 C): a listing made by hand on a venue (or its removal), as shown there. Never holds a walk-away. Append-only.
CREATE TABLE public.venue_listings (
  id bigserial PRIMARY KEY,
  domain text NOT NULL,
  venue text NOT NULL CHECK (venue IN ('afternic', 'sedo')),
  listed_at timestamptz NOT NULL,
  delisted boolean NOT NULL DEFAULT false,
  mode text NOT NULL,
  price_cents integer CHECK (price_cents IS NULL OR price_cents > 0),
  min_offer_cents integer CHECK (min_offer_cents IS NULL OR min_offer_cents > 0),
  evidence jsonb,
  note text,
  token_name text,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_listings_domain_idx ON public.venue_listings (domain, venue, id DESC);
CREATE TRIGGER venue_listings_append_only BEFORE DELETE OR UPDATE ON public.venue_listings FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER venue_listings_no_truncate BEFORE TRUNCATE ON public.venue_listings FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.venue_listings;
DROP TABLE public.registrar_state_checks;
