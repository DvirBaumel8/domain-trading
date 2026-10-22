-- Up Migration
-- v5.34.0 (BUG-052): every closeout name that left the feed before its ends_at, and every market episode labelled DISAPPEARED, gets an RDAP tag:
-- bought | deleted | unknown (rules in docs/internal/datasave.md "Disappearance tags"). Written by the datasave step buildPanel. Not in the backup.
CREATE TABLE public.disappearances (
  source text NOT NULL CHECK (source IN ('godaddy_closeouts', 'dynadot_closeouts', 'market_episode')),
  domain text NOT NULL,
  -- closeouts: the first stored day the name was missing; episodes: the day after last_seen
  gone_date date NOT NULL,
  prev_date date NOT NULL,
  ends_at timestamptz,
  episode_id text,
  -- the registrar the name had before it left: an RDAP answer stored before gone_date (rdap_cache), else the feed's own registrar (closeouts only)
  baseline_registrar text,
  baseline_source text CHECK (baseline_source IN ('rdap_cache', 'feed')),
  tag text NOT NULL DEFAULT 'unknown' CHECK (tag IN ('bought', 'deleted', 'unknown')),
  tag_reason text NOT NULL DEFAULT 'NOT_CHECKED',
  -- bought and deleted are final at once; an unknown is final 7 days after its first check (BUG-052 R-4)
  final boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  first_checked_at timestamptz,
  rdap_checked_at timestamptz,
  rdap_registrar text,
  rdap_statuses jsonb,
  rdap_created timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, domain, gone_date)
);
CREATE INDEX disappearances_pending_idx ON public.disappearances (final, gone_date DESC) WHERE NOT final;
CREATE UNIQUE INDEX disappearances_episode_idx ON public.disappearances (episode_id) WHERE episode_id IS NOT NULL;

-- RDAP lookups per datasave run for the tags (migration only). The bots' rolling limit (lookups_rdap_daily_limit) is not used: internal steps never count against it (CR-074).
ALTER TABLE public.settings ADD COLUMN disappearance_lookups_max_per_run integer NOT NULL DEFAULT 1500 CHECK (disappearance_lookups_max_per_run BETWEEN 0 AND 10000);
-- rows are kept this many days after gone_date
ALTER TABLE public.settings ADD COLUMN disappearance_keep_days integer NOT NULL DEFAULT 120 CHECK (disappearance_keep_days >= 8);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN disappearance_keep_days;
ALTER TABLE public.settings DROP COLUMN disappearance_lookups_max_per_run;
DROP TABLE public.disappearances;
