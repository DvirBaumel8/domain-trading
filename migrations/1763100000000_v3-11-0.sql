-- Up Migration
-- v3.11.0 (CR-044 .. CR-049). Founder rule 2: the domain cap is 40 (Dvir, 13 Oct 2026; caps change only by migration).
UPDATE public.settings SET max_domains = 40;
ALTER TABLE public.settings ALTER COLUMN max_domains SET DEFAULT 40;

-- CR-045 item 2 / CR-048: the horizon of a name, the sell-or-drop date of a trend or regulation name, the screening group (CR-045 item 3) and the buy card (renewal maths, CR-046 item 3).
ALTER TABLE public.domains ADD COLUMN horizon text NOT NULL DEFAULT 'evergreen' CHECK (horizon IN ('evergreen', 'trend', 'regulation'));
ALTER TABLE public.domains ADD COLUMN sell_or_drop_by date;
ALTER TABLE public.domains ADD COLUMN screening_group text CHECK (screening_group IN ('passed', 'borderline'));
ALTER TABLE public.domains ADD COLUMN buy_card jsonb;

-- The lander price check and the renewal-time lookalike re-check are two more portfolio check kinds.
ALTER TABLE public.portfolio_checks DROP CONSTRAINT portfolio_checks_kind_check;
ALTER TABLE public.portfolio_checks ADD CONSTRAINT portfolio_checks_kind_check CHECK (kind IN ('registry', 'web', 'blocklist', 'price', 'lookalikes'));

-- CR-044 item 2, CR-046 item 4, CR-049 item 5: views, leads, offers per name, month and venue, as the bots read them from the venues. Append-only.
CREATE TABLE public.portfolio_stats (
  id bigserial PRIMARY KEY,
  domain text NOT NULL,
  as_of date NOT NULL,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  venue text NOT NULL DEFAULT 'afternic' CHECK (venue IN ('afternic', 'sedo', 'sellerhub')),
  views integer CHECK (views >= 0),
  leads integer CHECK (leads >= 0),
  inquiries integer CHECK (inquiries >= 0),
  offers integer CHECK (offers >= 0),
  source text NOT NULL,
  token_name text,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (views IS NOT NULL OR leads IS NOT NULL OR inquiries IS NOT NULL OR offers IS NOT NULL)
);
CREATE INDEX portfolio_stats_domain_idx ON public.portfolio_stats (domain, month);
CREATE TRIGGER portfolio_stats_append_only BEFORE DELETE OR UPDATE ON public.portfolio_stats FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER portfolio_stats_no_truncate BEFORE TRUNCATE ON public.portfolio_stats FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- CR-045 item 5: the outreach log. The recipient is a company domain, never an address. A later reply or outcome for the same send updates its row (reply, outcome only).
CREATE TABLE public.outreach_emails (
  id bigserial PRIMARY KEY,
  domain text NOT NULL,
  recipient_domain text NOT NULL CHECK (recipient_domain = lower(recipient_domain) AND recipient_domain !~ '[@\s]'),
  sent_at timestamptz NOT NULL,
  reply boolean NOT NULL DEFAULT false,
  outcome text CHECK (outcome IN ('interested', 'declined', 'offer', 'sold', 'bounced', 'other')),
  token_name text,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, recipient_domain, sent_at)
);
CREATE INDEX outreach_emails_domain_idx ON public.outreach_emails (domain);

-- CR-044 item 6: the monthly holdout of screened, not bought names, and the one re-check after the delay.
CREATE TABLE public.holdout (
  id bigserial PRIMARY KEY,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  domain text NOT NULL,
  grp text NOT NULL CHECK (grp IN ('passed', 'failed')),
  run_id text,
  seed text NOT NULL,
  picked_at timestamptz NOT NULL DEFAULT now(),
  lookalikes_at_pick jsonb,
  recheck_at timestamptz,
  lookalikes_recheck jsonb,
  delta jsonb,
  UNIQUE (month, domain)
);

-- CR-044 item 4: uploaded sales (domain, price, date, venue). Append-only.
CREATE TABLE public.sales_pattern_uploads (
  id bigserial PRIMARY KEY,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  rows_n integer NOT NULL CHECK (rows_n > 0),
  token_name text,
  audit_id text
);
CREATE TABLE public.sales_pattern_rows (
  id bigserial PRIMARY KEY,
  upload_id bigint NOT NULL REFERENCES public.sales_pattern_uploads (id),
  domain text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  sold_on date NOT NULL,
  venue text
);
CREATE INDEX sales_pattern_rows_upload_idx ON public.sales_pattern_rows (upload_id);
CREATE TRIGGER sales_pattern_uploads_append_only BEFORE DELETE OR UPDATE ON public.sales_pattern_uploads FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER sales_pattern_uploads_no_truncate BEFORE TRUNCATE ON public.sales_pattern_uploads FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER sales_pattern_rows_append_only BEFORE DELETE OR UPDATE ON public.sales_pattern_rows FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER sales_pattern_rows_no_truncate BEFORE TRUNCATE ON public.sales_pattern_rows FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- CR-049 item 1: what the listingSync step sent to a venue (SellerHub) and what the venue reported. Append-only.
CREATE TABLE public.listing_sync_log (
  id bigserial PRIMARY KEY,
  domain text NOT NULL,
  venue text NOT NULL CHECK (venue IN ('sellerhub')),
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'sold_seen', 'error')),
  bin_cents integer CHECK (bin_cents > 0),
  min_offer_cents integer CHECK (min_offer_cents > 0),
  http_status integer,
  detail text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_sync_log_domain_idx ON public.listing_sync_log (domain, venue, id DESC);
CREATE TRIGGER listing_sync_log_append_only BEFORE DELETE OR UPDATE ON public.listing_sync_log FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER listing_sync_log_no_truncate BEFORE TRUNCATE ON public.listing_sync_log FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.listing_sync_log;
DROP TABLE public.sales_pattern_rows;
DROP TABLE public.sales_pattern_uploads;
DROP TABLE public.holdout;
DROP TABLE public.outreach_emails;
DROP TABLE public.portfolio_stats;
ALTER TABLE public.portfolio_checks DROP CONSTRAINT portfolio_checks_kind_check;
ALTER TABLE public.portfolio_checks ADD CONSTRAINT portfolio_checks_kind_check CHECK (kind IN ('registry', 'web', 'blocklist'));
ALTER TABLE public.domains DROP COLUMN buy_card, DROP COLUMN screening_group, DROP COLUMN sell_or_drop_by, DROP COLUMN horizon;
ALTER TABLE public.settings ALTER COLUMN max_domains SET DEFAULT 50;
UPDATE public.settings SET max_domains = 50;
