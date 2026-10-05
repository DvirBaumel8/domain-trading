-- Up Migration
CREATE TABLE payouts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id        bigint NOT NULL REFERENCES domains (id),
  sale_ledger_id   bigint NOT NULL UNIQUE REFERENCES ledger_entries (id),   -- one payout per sale
  fee_ledger_id    bigint REFERENCES ledger_entries (id),                   -- the payout_fee row, if any
  venue            text NOT NULL,
  amount_cents     integer NOT NULL CHECK (amount_cents > 0),               -- what the marketplace says it will pay out
  fee_cents        integer NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  method           text NOT NULL CHECK (length(trim(method)) > 0 AND position('@' in method) = 0),
  received_on      date,                                                    -- null until the money arrives
  transaction_ref  text CHECK (transaction_ref IS NULL OR position('@' in transaction_ref) = 0),
  audit_id         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION payouts_facts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payouts: DELETE is not allowed'; END IF;
  IF (NEW.domain_id, NEW.sale_ledger_id, NEW.fee_ledger_id, NEW.venue, NEW.amount_cents, NEW.fee_cents, NEW.method,
      NEW.transaction_ref, NEW.audit_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.domain_id, OLD.sale_ledger_id, OLD.fee_ledger_id, OLD.venue, OLD.amount_cents, OLD.fee_cents, OLD.method,
      OLD.transaction_ref, OLD.audit_id, OLD.created_at) THEN
    RAISE EXCEPTION 'payouts: facts are immutable';
  END IF;
  IF OLD.received_on IS NOT NULL AND NEW.received_on IS DISTINCT FROM OLD.received_on THEN
    RAISE EXCEPTION 'payouts: received_on is set once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payouts_immutable BEFORE UPDATE OR DELETE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_facts_immutable();
CREATE TRIGGER payouts_no_truncate BEFORE TRUNCATE ON payouts FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- How each sale was recorded: by whom, and on what evidence or approval
CREATE TABLE sales (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id        bigint NOT NULL REFERENCES domains (id),
  sale_ledger_id   bigint NOT NULL UNIQUE REFERENCES ledger_entries (id),
  venue            text NOT NULL,
  transaction_ref  text CHECK (transaction_ref IS NULL OR position('@' in transaction_ref) = 0),
  sale_price_cents integer NOT NULL,
  commission_cents integer NOT NULL,
  other_fees_cents integer NOT NULL DEFAULT 0,
  sold_at          timestamptz NOT NULL,
  offer_id         bigint REFERENCES offers (id),
  evidence_source  text CHECK (evidence_source IN ('afternic_email', 'sedo_email', 'afternic_dashboard', 'sedo_dashboard', 'escrow', 'other')),
  evidence_ref     text CHECK (evidence_ref IS NULL OR length(trim(evidence_ref)) > 0),
  approval_text    text,
  approval_at      timestamptz,
  recorded_by      text NOT NULL,
  confirmed        boolean NOT NULL DEFAULT false,                          -- true when Dvir's approval_ref was given
  audit_id         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_venue_transaction_ref_key UNIQUE (venue, transaction_ref),
  CONSTRAINT sales_evidence_or_approval CHECK (confirmed OR (evidence_source IS NOT NULL AND evidence_ref IS NOT NULL AND transaction_ref IS NOT NULL))
);
CREATE TRIGGER sales_append_only BEFORE UPDATE OR DELETE ON sales FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER sales_no_truncate BEFORE TRUNCATE ON sales FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Down Migration
DROP TABLE sales;
DROP TABLE payouts;
DROP FUNCTION payouts_facts_immutable();
