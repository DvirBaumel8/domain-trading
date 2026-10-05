-- Up Migration

CREATE TABLE pricing_settings (
  version                      integer PRIMARY KEY CHECK (version >= 1),
  effective_at                 timestamptz NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  approval_text                text NOT NULL CHECK (length(trim(approval_text)) > 0),
  approval_at                  timestamptz NOT NULL,
  note                         text,
  geo_bin_strong_cents         integer NOT NULL CHECK (geo_bin_strong_cents > 0),
  geo_bin_weaker_cents         integer NOT NULL CHECK (geo_bin_weaker_cents > 0),
  geo_bin_min_cents            integer NOT NULL CHECK (geo_bin_min_cents > 0),
  geo_bin_max_cents            integer NOT NULL,
  geo_drops_enabled            boolean NOT NULL,
  geo_drops                    jsonb NOT NULL,
  floor_bps                    integer NOT NULL CHECK (floor_bps BETWEEN 1 AND 10000),
  floor_min_cents              integer NOT NULL CHECK (floor_min_cents > 0),
  walkaway_bps                 integer NOT NULL CHECK (walkaway_bps BETWEEN 1 AND 10000),
  walkaway_min_cents           integer NOT NULL CHECK (walkaway_min_cents > 0),
  hybrid_min_offer_cents       integer NOT NULL CHECK (hybrid_min_offer_cents >= 2000),
  drops                        jsonb NOT NULL,
  final_push_days_before_drop  integer NOT NULL CHECK (final_push_days_before_drop > 0),
  final_push_mode              text NOT NULL CHECK (final_push_mode IN ('bin_to_floor_ceil95')),
  delist_days_before_drop      integer NOT NULL CHECK (delist_days_before_drop > 0),
  headsup_days_before          integer NOT NULL CHECK (headsup_days_before >= 0),
  comps_min                    integer NOT NULL CHECK (comps_min >= 1),
  comps_max                    integer NOT NULL,
  public_lto                   boolean NOT NULL,
  CHECK (geo_bin_min_cents <= geo_bin_weaker_cents AND geo_bin_weaker_cents <= geo_bin_strong_cents AND geo_bin_strong_cents <= geo_bin_max_cents),
  CHECK (walkaway_bps <= floor_bps),
  CHECK (walkaway_min_cents <= floor_min_cents),
  CHECK (comps_min <= comps_max),
  CHECK (final_push_days_before_drop > delist_days_before_drop)
);
CREATE TRIGGER pricing_settings_append_only BEFORE UPDATE OR DELETE ON pricing_settings
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER pricing_settings_no_truncate BEFORE TRUNCATE ON pricing_settings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- v2 = Dvir, 5 Oct 2026, 09:17 IDT (listing-strategy.md §10.1). Reused by the test reset (plan P2).
CREATE FUNCTION seed_pricing_settings_v2() RETURNS void LANGUAGE sql AS $$
  INSERT INTO pricing_settings (
    version, effective_at, approval_text, approval_at, note,
    geo_bin_strong_cents, geo_bin_weaker_cents, geo_bin_min_cents, geo_bin_max_cents,
    geo_drops_enabled, geo_drops, floor_bps, floor_min_cents, walkaway_bps, walkaway_min_cents,
    hybrid_min_offer_cents, drops, final_push_days_before_drop, final_push_mode,
    delist_days_before_drop, headsup_days_before, comps_min, comps_max, public_lto
  ) VALUES (
    2, '2026-10-05T09:17:00+03:00',
    'v2: $500 walk-away floor, one geo drop, Sedo make-offer, final push to floor', '2026-10-05T09:17:00+03:00',
    'pricing rules v2 (Gavriel spec commit 3488942, approved by Dvir)',
    49900, 39900, 29900, 49900,
    true, '[{"after_months":12,"from_cents":49900,"to_cents":39900}]'::jsonb,
    6500, 75000, 4800, 50000,
    10000, '[{"after_months":6,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]'::jsonb, 90, 'bin_to_floor_ceil95',
    7, 7, 2, 3, false
  );
$$;
SELECT seed_pricing_settings_v2();

-- Domains: v2 pricing columns + delisted status (listing-strategy.md §10.10)
ALTER TABLE domains DROP CONSTRAINT domains_status_check;
ALTER TABLE domains ADD CONSTRAINT domains_status_check
  CHECK (status IN ('pending_purchase', 'owned', 'listed', 'delisted', 'sold', 'dropped'));
ALTER TABLE domains
  ADD COLUMN walkaway_cents integer CHECK (walkaway_cents > 0),
  ADD COLUMN price_grade text CHECK (price_grade IN ('strong', 'weaker')),
  ADD COLUMN pricing_source text CHECK (pricing_source IN ('formula', 'approved_exception')),
  ADD COLUMN pricing_settings_version integer REFERENCES pricing_settings (version),
  ADD COLUMN first_listed_at timestamptz,
  ADD COLUMN pricing_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN pricing_hold_reason text,
  ADD COLUMN plan_id text,
  ADD COLUMN plan_audit_id text,
  ADD COLUMN export_pending_since timestamptz,
  ADD CONSTRAINT domains_price_order CHECK (
    (floor_cents IS NULL OR bin_cents IS NULL OR floor_cents <= bin_cents)
    AND (walkaway_cents IS NULL OR (floor_cents IS NOT NULL AND walkaway_cents <= floor_cents))
  );

-- Listing history: v2 fields + scheduled changes
ALTER TABLE listing_history DROP CONSTRAINT listing_history_source_check;
ALTER TABLE listing_history ADD CONSTRAINT listing_history_source_check
  CHECK (source IN ('buy', 'import', 'list', 'schedule'));
ALTER TABLE listing_history
  ADD COLUMN price_grade text CHECK (price_grade IN ('strong', 'weaker')),
  ADD COLUMN walkaway_cents integer CHECK (walkaway_cents > 0),
  ADD COLUMN pricing_source text CHECK (pricing_source IN ('formula', 'approved_exception')),
  ADD COLUMN pricing_settings_version integer REFERENCES pricing_settings (version),
  -- no FK on purpose: price_schedule.listing_history_id already links the other way; a two-way FK would be circular
  ADD COLUMN schedule_event_id bigint,
  ADD COLUMN plan_audit_id text;

CREATE TABLE price_schedule (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id           bigint NOT NULL REFERENCES domains (id),
  plan_id             text NOT NULL,
  event               text NOT NULL CHECK (event IN ('drop1_m6', 'drop2_m18', 'geo_drop_m12', 'final_push', 'delist')),
  due_on              date NOT NULL,
  bin_cents           integer CHECK (bin_cents > 0),
  floor_cents         integer CHECK (floor_cents > 0),
  walkaway_cents      integer CHECK (walkaway_cents > 0),
  settings_version    integer NOT NULL REFERENCES pricing_settings (version),
  status              text NOT NULL CHECK (status IN ('planned', 'applied', 'skipped_at_minimum', 'skipped_no_change',
                        'skipped_disabled', 'superseded', 'superseded_by_final_push', 'cancelled', 'failed')),
  applied_at          timestamptz,
  listing_history_id  bigint REFERENCES listing_history (id),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, event, plan_id),
  CONSTRAINT price_schedule_planned_shape CHECK (
    status <> 'planned'
    OR (event = 'delist' AND bin_cents IS NULL AND floor_cents IS NULL AND walkaway_cents IS NULL)
    OR (event <> 'delist' AND bin_cents IS NOT NULL AND floor_cents IS NOT NULL AND walkaway_cents IS NOT NULL
        AND walkaway_cents <= floor_cents AND floor_cents <= bin_cents)
  )
);
CREATE INDEX price_schedule_due ON price_schedule (status, due_on);

CREATE TABLE pricing_evidence (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id               bigint NOT NULL REFERENCES domains (id),
  comps                   jsonb,
  rationale               text,
  legacy_no_comps_reason  text,
  audit_id                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (comps IS NOT NULL OR legacy_no_comps_reason IS NOT NULL)
);
CREATE TRIGGER pricing_evidence_append_only BEFORE UPDATE OR DELETE ON pricing_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER pricing_evidence_no_truncate BEFORE TRUNCATE ON pricing_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Caps raised (Dvir, 5 Oct 2026, 01:04 IDT; confirmed in chat with Claude Code)
ALTER TABLE settings ALTER COLUMN poc_cap_cents SET DEFAULT 150000;
ALTER TABLE settings ALTER COLUMN max_domains SET DEFAULT 50;
UPDATE settings SET poc_cap_cents = 150000, max_domains = 50, updated_at = now();

-- Down Migration

UPDATE settings SET poc_cap_cents = 50000, max_domains = 10, updated_at = now();
ALTER TABLE settings ALTER COLUMN max_domains SET DEFAULT 10;
ALTER TABLE settings ALTER COLUMN poc_cap_cents SET DEFAULT 50000;
DROP TABLE pricing_evidence;
DROP TABLE price_schedule;
ALTER TABLE listing_history DROP COLUMN plan_audit_id, DROP COLUMN schedule_event_id, DROP COLUMN pricing_settings_version,
  DROP COLUMN pricing_source, DROP COLUMN walkaway_cents, DROP COLUMN price_grade;
ALTER TABLE listing_history DROP CONSTRAINT listing_history_source_check;
ALTER TABLE listing_history ADD CONSTRAINT listing_history_source_check CHECK (source IN ('buy', 'import', 'list'));
ALTER TABLE domains DROP CONSTRAINT domains_price_order;
ALTER TABLE domains DROP COLUMN export_pending_since, DROP COLUMN plan_audit_id, DROP COLUMN plan_id,
  DROP COLUMN pricing_hold_reason, DROP COLUMN pricing_hold, DROP COLUMN first_listed_at,
  DROP COLUMN pricing_settings_version, DROP COLUMN pricing_source, DROP COLUMN price_grade, DROP COLUMN walkaway_cents;
ALTER TABLE domains DROP CONSTRAINT domains_status_check;
ALTER TABLE domains ADD CONSTRAINT domains_status_check
  CHECK (status IN ('pending_purchase', 'owned', 'listed', 'sold', 'dropped'));
DROP FUNCTION seed_pricing_settings_v2();
DROP TABLE pricing_settings;
