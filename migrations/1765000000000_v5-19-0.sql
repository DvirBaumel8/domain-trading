-- Up Migration
-- v5.19.0 (Dvir, 19 Oct 2026: an approved CR needs no further lines from him): the CR-068 visitor counter is on, and the visit-counter token is requested,
-- so the Mac host's deploy tick hands it to the api-proxy Worker (scripts/local-host/visits-token.sh) with no call and no person seeing it.
ALTER TABLE public.settings ALTER COLUMN visits_enabled SET DEFAULT true;
UPDATE public.settings SET visits_enabled = true;
UPDATE public.settings SET visits_token_request = 'requested', visits_token_requested_at = now() WHERE visits_token_request IS NULL;

-- Down Migration
ALTER TABLE public.settings ALTER COLUMN visits_enabled SET DEFAULT false;
