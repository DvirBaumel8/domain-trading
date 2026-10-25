-- Up Migration
-- v5.39.0 (CR-077): auction bid plans. A pre-bid safety check (prebid_checks, append-only), a bid plan approved by Dvir (bid_plans, one open plan per name,
-- status changes only through the result route, the S8 import and the expiry on a new plan; every change is a row in bid_plan_events, append-only),
-- and settings.s8_closeouts_allowed (migration only; closeouts get no money until the pick-proof test shows an edge). Backup: bid_plans, bid_plan_events, prebid_checks exported.
CREATE TABLE public.prebid_checks (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain)),
  venue text NOT NULL CHECK (venue IN ('godaddy', 'dynadot')),
  verdict text NOT NULL CHECK (verdict IN ('pass', 'flag', 'fail')),
  answer jsonb NOT NULL,
  token_name text,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prebid_checks_domain_idx ON public.prebid_checks (domain, id DESC);
CREATE TRIGGER prebid_checks_append_only BEFORE DELETE OR UPDATE ON public.prebid_checks FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER prebid_checks_no_truncate BEFORE TRUNCATE ON public.prebid_checks FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TABLE public.bid_plans (
  id bigserial PRIMARY KEY,
  domain text NOT NULL CHECK (domain = lower(domain)),
  venue text NOT NULL CHECK (venue IN ('godaddy', 'dynadot')),
  kind text NOT NULL CHECK (kind IN ('auction', 'fixed_price', 'closeout')),
  auction_end_at timestamptz,
  max_bid_cents integer NOT NULL CHECK (max_bid_cents > 0),
  prebid_id bigint NOT NULL REFERENCES public.prebid_checks (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'withdrawn', 'expired')),
  manual jsonb NOT NULL,
  reasons jsonb NOT NULL,
  approval_text text NOT NULL,
  approval_at timestamptz NOT NULL,
  created_by text,
  audit_id text,
  final_price_cents integer CHECK (final_price_cents IS NULL OR final_price_cents > 0),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'auction' OR auction_end_at IS NOT NULL)
);
CREATE UNIQUE INDEX bid_plans_one_open ON public.bid_plans (domain) WHERE status = 'open';
CREATE INDEX bid_plans_domain_idx ON public.bid_plans (domain, id DESC);

CREATE TABLE public.bid_plan_events (
  id bigserial PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES public.bid_plans (id),
  event text NOT NULL CHECK (event IN ('created', 'won', 'lost', 'withdrawn', 'expired', 'imported')),
  from_status text,
  to_status text NOT NULL,
  final_price_cents integer,
  ended_at timestamptz,
  detail jsonb,
  actor text,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bid_plan_events_plan_idx ON public.bid_plan_events (plan_id, id);
CREATE TRIGGER bid_plan_events_append_only BEFORE DELETE OR UPDATE ON public.bid_plan_events FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER bid_plan_events_no_truncate BEFORE TRUNCATE ON public.bid_plan_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- closeouts get no money until the pick-proof test shows an edge (Dvir, 25 Oct 2026); only a migration turns this on
ALTER TABLE public.settings ADD COLUMN s8_closeouts_allowed boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE public.settings DROP COLUMN s8_closeouts_allowed;
DROP TABLE public.bid_plan_events;
DROP TABLE public.bid_plans;
DROP TABLE public.prebid_checks;
