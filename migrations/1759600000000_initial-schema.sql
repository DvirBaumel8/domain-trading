-- Up Migration

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TABLE api_tokens (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  scope         text NOT NULL CHECK (scope IN ('read', 'write')),
  token_sha256  text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);
CREATE UNIQUE INDEX api_tokens_active_name ON api_tokens (name) WHERE revoked_at IS NULL;

-- One row only. Changed only by the admin command or a migration, never the API.
CREATE TABLE settings (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  poc_cap_cents             integer NOT NULL DEFAULT 50000 CHECK (poc_cap_cents > 0),
  max_domains               integer NOT NULL DEFAULT 10 CHECK (max_domains > 0),
  approval_max_age_hours    integer NOT NULL DEFAULT 72 CHECK (approval_max_age_hours > 0),
  lander_target             text NOT NULL DEFAULT 'afternic' CHECK (lander_target IN ('afternic', 'sedo', 'custom')),
  allowed_registrars        text[] NOT NULL DEFAULT '{porkbun}'
                            CHECK (NOT ('cloudflare' = ANY (lower(allowed_registrars::text)::text[]))),
  geo_bin_min_cents         integer NOT NULL DEFAULT 29900,
  geo_bin_max_cents         integer NOT NULL DEFAULT 49900,
  high_value_categories     text[] NOT NULL DEFAULT '{trend,b2b,collision,regulation,buzzword}',
  high_value_min_bin_cents  integer NOT NULL DEFAULT 250000 CHECK (high_value_min_bin_cents > 0),
  high_value_guard_modes    text[] NOT NULL DEFAULT '{bin}',
  sedo_hybrid_as            text NOT NULL DEFAULT 'buy_now' CHECK (sedo_hybrid_as IN ('buy_now', 'make_offer')),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (geo_bin_min_cents > 0 AND geo_bin_min_cents <= geo_bin_max_cents),
  CHECK (high_value_guard_modes <@ ARRAY['bin', 'offer', 'hybrid']),
  CHECK (high_value_categories <@ ARRAY['geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other'])
);
INSERT INTO settings DEFAULT VALUES;

CREATE TABLE deals (
  id           text PRIMARY KEY CHECK (id ~ '^D-[0-9]{3,}$'),
  domain       text CHECK (domain = lower(domain)),
  strategy     text,
  status_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domains (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain               text NOT NULL UNIQUE CHECK (domain = lower(domain) AND length(domain) BETWEEN 4 AND 253),
  deal_id              text CHECK (deal_id ~ '^D-[0-9]{3,}$'),
  registrar            text CHECK (lower(registrar) <> 'cloudflare'),
  status               text NOT NULL CHECK (status IN ('pending_purchase', 'owned', 'listed', 'sold', 'dropped')),
  buy_date             date,
  cost_cents           integer CHECK (cost_cents >= 0),
  expiry_date          date,
  renewal_price_cents  integer CHECK (renewal_price_cents >= 0),
  renewals_used        smallint NOT NULL DEFAULT 0 CHECK (renewals_used BETWEEN 0 AND 1),
  drop_date            date,
  category             text CHECK (category IN ('geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other')),
  listing_mode         text CHECK (listing_mode IN ('bin', 'offer', 'hybrid')),
  bin_cents            integer CHECK (bin_cents > 0),
  floor_cents          integer CHECK (floor_cents > 0),
  min_offer_cents      integer CHECK (min_offer_cents >= 2000),
  lto_max_months       smallint CHECK (lto_max_months BETWEEN 2 AND 60),
  display_name         text,
  lander               text,
  lander_ns            text[],
  lander_set_at        timestamptz,
  ns_verified_at       timestamptz,
  registrar_api        text CHECK (registrar_api IN ('full', 'manage', 'none')),
  sold_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domains_category_once_owned CHECK (status = 'pending_purchase' OR category IS NOT NULL),
  CONSTRAINT domains_owned_fields CHECK (
    status = 'pending_purchase' OR (
      registrar IS NOT NULL AND registrar_api IS NOT NULL AND buy_date IS NOT NULL
      AND cost_cents IS NOT NULL AND expiry_date IS NOT NULL AND drop_date IS NOT NULL
    )
  ),
  CONSTRAINT domains_drop_date_rule CHECK (
    renewals_used = 1 OR drop_date IS NULL OR drop_date = (expiry_date + interval '1 year')::date
  )
);

CREATE TABLE ledger_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_on   date NOT NULL,
  domain_id     bigint REFERENCES domains (id),
  deal_id       text,
  type          text NOT NULL CHECK (type IN ('registration', 'renewal', 'fee', 'commission', 'sale',
                                              'payout_fee', 'refund', 'tool', 'ai', 'adjustment')),
  amount_cents  integer NOT NULL CHECK (amount_cents <> 0),
  currency      text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  counterparty  text,
  receipt_ref   text,
  note          text,
  audit_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_domain ON ledger_entries (domain_id);

CREATE TABLE listing_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id        bigint NOT NULL REFERENCES domains (id),
  at               timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL CHECK (source IN ('buy', 'import', 'list')),
  category         text CHECK (category IN ('geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other')),
  mode             text CHECK (mode IN ('bin', 'offer', 'hybrid')),
  bin_cents        integer CHECK (bin_cents > 0),
  floor_cents      integer CHECK (floor_cents > 0),
  min_offer_cents  integer CHECK (min_offer_cents >= 2000),
  lto_max_months   smallint CHECK (lto_max_months BETWEEN 2 AND 60),
  lander           text,
  override         boolean NOT NULL DEFAULT false,
  override_reason  text,
  approval_text    text,
  approval_at      timestamptz,
  audit_id         text
);
CREATE INDEX listing_history_domain ON listing_history (domain_id, at);

CREATE TABLE quotes (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id                text NOT NULL,
  domain                  text NOT NULL CHECK (domain = lower(domain)),
  registrar               text NOT NULL,
  quoted_at               timestamptz NOT NULL DEFAULT now(),
  available               boolean,
  premium                 boolean,
  first_year_cents        integer,
  renewal_cents           integer,
  privacy_cents_per_year  integer,
  two_year_cents          integer,
  eligible                boolean NOT NULL,
  exclusion_reason        text,
  raw                     jsonb
);
CREATE INDEX quotes_check ON quotes (check_id);
CREATE INDEX quotes_domain ON quotes (domain, quoted_at);

CREATE TABLE purchases (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,
  request_hash     text NOT NULL,
  domain           text NOT NULL CHECK (domain = lower(domain)),
  state            text NOT NULL CHECK (state IN ('created', 'register_sent', 'succeeded', 'failed', 'unknown')),
  dry_run          boolean NOT NULL DEFAULT false,
  registrar        text CHECK (lower(registrar) <> 'cloudflare'),
  check_id         text,
  charged_cents    integer CHECK (charged_cents >= 0),
  order_id         text,
  max_price_cents  integer NOT NULL CHECK (max_price_cents > 0),
  approval_text    text NOT NULL,
  approval_at      timestamptz NOT NULL,
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Spec (00-architecture §4): one created/register_sent/succeeded/unknown row per domain (D4, Dvir 4 Oct 2026).
CREATE UNIQUE INDEX purchases_one_open_per_domain ON purchases (domain)
  WHERE state IN ('created', 'register_sent', 'succeeded', 'unknown');

CREATE TABLE receipts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id  bigint REFERENCES purchases (id),
  registrar    text NOT NULL,
  order_id     text NOT NULL,
  raw          jsonb,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id               text PRIMARY KEY CHECK (id ~ '^aud_[0-9a-f]{32}$'),
  at               timestamptz NOT NULL DEFAULT now(),
  token_id         bigint REFERENCES api_tokens (id),
  scope            text CHECK (scope IN ('read', 'write', 'admin')),
  method           text NOT NULL,
  path             text NOT NULL,
  idempotency_key  text,
  approval_text    text,
  approval_at      timestamptz,
  request          jsonb,
  status_code      integer NOT NULL,
  result_summary   text,
  client_ip        text
);
CREATE INDEX audit_log_at ON audit_log (at);

CREATE TABLE idempotency_keys (
  key                    text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 255),
  request_hash           text NOT NULL,
  method                 text NOT NULL,
  path                   text NOT NULL,
  token_id               bigint REFERENCES api_tokens (id),
  state                  text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  status_code            integer,
  response_body          text,
  response_content_type  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz
);

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER listing_history_append_only BEFORE UPDATE OR DELETE ON listing_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER listing_history_no_truncate BEFORE TRUNCATE ON listing_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Down Migration

DROP TABLE idempotency_keys, audit_log, receipts, purchases, quotes, listing_history,
  ledger_entries, domains, deals, settings, api_tokens;
DROP FUNCTION reject_mutation();
