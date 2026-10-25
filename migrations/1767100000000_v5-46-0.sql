-- Up Migration
-- v5.46.0: the unsold feed for closeout names that stayed on the list to their end date (nobody bought them even at the lowest price). One row per (name, end time),
-- recorded while the name is still in datasave_pool (the pool keeps only a few days); RDAP checks after ends_on + wait days decide dropped / held / unknown.
-- Rules: docs/internal/closeouts.md "Closeout expiries". Settings are migration-only.
CREATE TABLE public.closeout_expiries (
  domain text NOT NULL CHECK (domain = lower(domain)),
  ends_at timestamptz NOT NULL,
  ends_on date NOT NULL,
  first_seen_on date NOT NULL,
  tag text NOT NULL DEFAULT 'pending' CHECK (tag IN ('pending', 'dropped', 'held', 'unknown')),
  tag_reason text,
  caught boolean,
  attempts integer NOT NULL DEFAULT 0,
  rdap_checked_at timestamptz,
  rdap_registrar text,
  rdap_statuses jsonb,
  rdap_created timestamptz,
  rdap_expires timestamptz,
  final boolean NOT NULL DEFAULT false,
  fed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, ends_at),
  CHECK (NOT final OR tag <> 'pending')
);
CREATE INDEX closeout_expiries_open ON public.closeout_expiries (ends_on) WHERE NOT final;
CREATE INDEX closeout_expiries_unfed ON public.closeout_expiries (ends_on) WHERE tag = 'dropped' AND fed_at IS NULL;
ALTER TABLE public.settings ADD COLUMN closeout_expiry_wait_days integer NOT NULL DEFAULT 3 CHECK (closeout_expiry_wait_days BETWEEN 0 AND 60);
ALTER TABLE public.settings ADD COLUMN closeout_expiry_recheck_days integer NOT NULL DEFAULT 7 CHECK (closeout_expiry_recheck_days BETWEEN 1 AND 60);
ALTER TABLE public.settings ADD COLUMN closeout_expiry_max_days integer NOT NULL DEFAULT 80 CHECK (closeout_expiry_max_days BETWEEN 7 AND 365);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN closeout_expiry_max_days;
ALTER TABLE public.settings DROP COLUMN closeout_expiry_recheck_days;
ALTER TABLE public.settings DROP COLUMN closeout_expiry_wait_days;
DROP TABLE public.closeout_expiries;
