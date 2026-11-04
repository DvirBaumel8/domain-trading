-- Up Migration
-- v6.4.0 (CR-101): auction_kills, the server-side store of auction names a bot already judged and threw away. GET /auctions/shortlist leaves out a name that has an
-- active (not revoked) kill, unless the re-show rule fires (price halved for a tier_a / tier_b / card kill, or the kill is older than settings.shortlist_kill_ttl_days).
-- Append-only (reject_mutation, like tm_kills): a wrong kill is undone by a new row with kill_stage 'revoked' and `supersedes` = the id of the kill. Stored
-- auction_shortlist rows are never touched. Backup: not exported (tests/modules/ops/unit/backup-coverage.test.ts).
CREATE TABLE public.auction_kills (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+\.com$'),
  kill_stage text NOT NULL CHECK (kill_stage IN ('meaning_shape', 'tier_a', 'tier_b', 'card', 'prior_exclude', 'declined', 'hold', 'other', 'revoked')),
  kill_detail text CHECK (kill_detail IS NULL OR (char_length(kill_detail) BETWEEN 1 AND 500 AND position('@' IN kill_detail) = 0)),
  price_cents_at_kill integer CHECK (price_cents_at_kill IS NULL OR price_cents_at_kill > 0),
  data_date_at_kill date NOT NULL,
  run_id text NOT NULL CHECK (char_length(run_id) BETWEEN 1 AND 80),
  killed_at timestamptz NOT NULL,
  supersedes bigint REFERENCES public.auction_kills (id),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kill_stage = 'revoked') = (supersedes IS NOT NULL))
);
-- the duplicate rule of the CR is (domain, kill_stage, data_date_at_kill); a revoke row also carries what it revokes, so two kills of one name can be revoked on one day
CREATE UNIQUE INDEX auction_kills_dup_idx ON public.auction_kills (domain, kill_stage, data_date_at_kill, (coalesce(supersedes, 0)));
CREATE INDEX auction_kills_domain_idx ON public.auction_kills (domain);
CREATE INDEX auction_kills_supersedes_idx ON public.auction_kills (supersedes) WHERE supersedes IS NOT NULL;

CREATE TRIGGER auction_kills_append_only BEFORE DELETE OR UPDATE ON public.auction_kills FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER auction_kills_no_truncate BEFORE TRUNCATE ON public.auction_kills FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- days after which a killed name may be shown again (migration only, no API write)
ALTER TABLE public.settings ADD COLUMN shortlist_kill_ttl_days integer NOT NULL DEFAULT 90 CHECK (shortlist_kill_ttl_days BETWEEN 1 AND 3650);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN shortlist_kill_ttl_days;
DROP TABLE public.auction_kills;
