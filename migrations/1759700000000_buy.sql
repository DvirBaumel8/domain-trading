-- Up Migration

ALTER TABLE purchases ADD COLUMN expected_cents integer CHECK (expected_cents > 0);
ALTER TABLE purchases ADD COLUMN request jsonb;
ALTER TABLE purchases ADD COLUMN audit_id text;
ALTER TABLE receipts ADD CONSTRAINT receipts_one_per_purchase UNIQUE (purchase_id);
CREATE INDEX purchases_open_state ON purchases (state) WHERE state IN ('created', 'register_sent', 'unknown');

-- Down Migration

DROP INDEX purchases_open_state;
ALTER TABLE receipts DROP CONSTRAINT receipts_one_per_purchase;
ALTER TABLE purchases DROP COLUMN audit_id;
ALTER TABLE purchases DROP COLUMN request;
ALTER TABLE purchases DROP COLUMN expected_cents;
