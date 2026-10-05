-- Up Migration
CREATE TABLE offer_imports (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_sha256  text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  rows         integer NOT NULL CHECK (rows >= 0),
  inserted     integer NOT NULL CHECK (inserted >= 0),
  duplicates   integer NOT NULL CHECK (duplicates >= 0),
  recorded_by  text NOT NULL,
  audit_id     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER offer_imports_append_only BEFORE UPDATE OR DELETE ON offer_imports FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER offer_imports_no_truncate BEFORE TRUNCATE ON offer_imports FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE offers (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id              bigint NOT NULL REFERENCES domains (id),
  amount_cents           integer NOT NULL CHECK (amount_cents > 0),
  source                 text NOT NULL CHECK (source IN ('afternic','godaddy','sedo','domainagents','email_inbound','outbound_reply','other')),
  received_at            timestamptz NOT NULL,
  buyer_type             text NOT NULL DEFAULT 'unknown' CHECK (buyer_type IN ('end_user','investor','broker','unknown')),
  buyer_ref              text CHECK (buyer_ref IS NULL OR position('@' in buyer_ref) = 0),
  external_ref           text,
  bin_cents_at           integer, floor_cents_at integer, walkaway_cents_at integer, min_offer_cents_at integer,
  listing_history_id     bigint REFERENCES listing_history (id),
  band                   text NOT NULL CHECK (band IN ('below_min','below_walkaway','mid_range','at_or_above_floor','at_or_above_bin','geo_below_bin','unpriced')),
  routing                text NOT NULL CHECK (routing IN ('auto_decline','dvir','auto_accept','accept_preapproved')),
  outcome                text NOT NULL CHECK (outcome IN ('declined_auto','open','declined','countered','accepted','expired','withdrawn','sold')),
  outcome_at             timestamptz,
  outcome_note           text CHECK (outcome_note IS NULL OR position('@' in outcome_note) = 0),
  outcome_approval_text  text,
  note                   text CHECK (note IS NULL OR position('@' in note) = 0),
  recorded_by            text NOT NULL,
  import_id              bigint REFERENCES offer_imports (id),
  audit_id               text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX offers_source_external_ref ON offers (source, external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX offers_natural_key ON offers (domain_id, amount_cents, source, received_at) WHERE external_ref IS NULL;
CREATE INDEX offers_domain_received ON offers (domain_id, received_at DESC);

CREATE FUNCTION offers_facts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offers: DELETE is not allowed'; END IF;
  IF (NEW.domain_id, NEW.amount_cents, NEW.source, NEW.received_at, NEW.buyer_type, NEW.buyer_ref, NEW.external_ref,
      NEW.bin_cents_at, NEW.floor_cents_at, NEW.walkaway_cents_at, NEW.min_offer_cents_at, NEW.listing_history_id,
      NEW.band, NEW.routing, NEW.note, NEW.recorded_by, NEW.import_id, NEW.audit_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.domain_id, OLD.amount_cents, OLD.source, OLD.received_at, OLD.buyer_type, OLD.buyer_ref, OLD.external_ref,
      OLD.bin_cents_at, OLD.floor_cents_at, OLD.walkaway_cents_at, OLD.min_offer_cents_at, OLD.listing_history_id,
      OLD.band, OLD.routing, OLD.note, OLD.recorded_by, OLD.import_id, OLD.audit_id, OLD.created_at) THEN
    RAISE EXCEPTION 'offers: facts are immutable; only outcome fields may change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offers_immutable BEFORE UPDATE OR DELETE ON offers FOR EACH ROW EXECUTE FUNCTION offers_facts_immutable();
CREATE TRIGGER offers_no_truncate BEFORE TRUNCATE ON offers FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Down Migration
DROP TABLE offers;
DROP FUNCTION offers_facts_immutable();
DROP TABLE offer_imports;
