-- Up Migration
-- v5.29.0 (CR-074): one RDAP cache shared by the bot routes and the internal steps, and the rolling-window usage log of the bots' live lookups.
-- Backup: neither table is exported (backup-coverage test states the reason for each).

-- Settings (migration only). TTL of a cached answer and the live bot lookups allowed in any rolling 24 hours.
ALTER TABLE public.settings ADD COLUMN lookups_rdap_ttl_hours integer NOT NULL DEFAULT 24 CHECK (lookups_rdap_ttl_hours BETWEEN 1 AND 720);
ALTER TABLE public.settings ADD COLUMN lookups_rdap_daily_limit integer NOT NULL DEFAULT 200 CHECK (lookups_rdap_daily_limit BETWEEN 0 AND 100000);

-- Newest definite answer per name (registered or not registered). An error answer (timeout, 429, source error) is never stored here.
CREATE TABLE public.rdap_cache (
  domain text PRIMARY KEY,
  registered boolean,
  created timestamptz,
  expires timestamptz,
  registrar text,
  statuses text[] NOT NULL DEFAULT '{}',
  nameservers text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz,
  checked_at timestamptz NOT NULL,
  reason_code text
);
CREATE INDEX rdap_cache_checked_at_idx ON public.rdap_cache (checked_at);

-- One row per live lookup a bot call made (reserved before the lookup runs). The limit counts rows with at > now - 24 h.
CREATE TABLE public.lookup_usage (
  id bigserial PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('rdap')),
  at timestamptz NOT NULL,
  by_token text NOT NULL
);
CREATE INDEX lookup_usage_source_at_idx ON public.lookup_usage (source, at);

-- Down Migration
DROP TABLE public.lookup_usage;
DROP TABLE public.rdap_cache;
ALTER TABLE public.settings DROP COLUMN lookups_rdap_daily_limit;
ALTER TABLE public.settings DROP COLUMN lookups_rdap_ttl_hours;
