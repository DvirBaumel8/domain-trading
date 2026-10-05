-- Up Migration
-- Removed 6 Oct 2026 (Dvir): the payouts table and the offers CSV import.
DROP TABLE payouts;
DROP FUNCTION payouts_facts_immutable();

-- offers.import_id only linked an offer to its import; drop it from the immutability trigger first.
CREATE OR REPLACE FUNCTION offers_facts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offers: DELETE is not allowed'; END IF;
  IF (NEW.domain_id, NEW.amount_cents, NEW.source, NEW.received_at, NEW.buyer_type, NEW.buyer_ref, NEW.external_ref,
      NEW.bin_cents_at, NEW.floor_cents_at, NEW.walkaway_cents_at, NEW.min_offer_cents_at, NEW.listing_history_id,
      NEW.band, NEW.routing, NEW.note, NEW.recorded_by, NEW.audit_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.domain_id, OLD.amount_cents, OLD.source, OLD.received_at, OLD.buyer_type, OLD.buyer_ref, OLD.external_ref,
      OLD.bin_cents_at, OLD.floor_cents_at, OLD.walkaway_cents_at, OLD.min_offer_cents_at, OLD.listing_history_id,
      OLD.band, OLD.routing, OLD.note, OLD.recorded_by, OLD.audit_id, OLD.created_at) THEN
    RAISE EXCEPTION 'offers: facts are immutable; only outcome fields may change';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE offers DROP COLUMN import_id;
DROP TABLE offer_imports;

-- Down Migration
-- Irreversible: the dropped tables held data. Re-create from 1760300000000_offers.sql and 1760500000000_payouts.sql if ever needed.
SELECT 1;
