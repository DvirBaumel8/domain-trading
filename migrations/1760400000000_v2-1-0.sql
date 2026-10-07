-- Up Migration
-- v2.1.0 (CR-004 §10.3): POST /list with lander "none" stores a listing with no nameserver action; the name stays "lander pending"
-- until a later call picks a lander. Additive, default false.
ALTER TABLE public.domains ADD COLUMN lander_pending boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE public.domains DROP COLUMN lander_pending;
