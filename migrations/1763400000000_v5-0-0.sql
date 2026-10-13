-- Up Migration
-- v5.0.0 (G-86, Dvir 14 Oct 2026): the service tracks no money budget. Gavriel owns it.
-- Drops the $1,500 POC cap, the tranche spend cap and the tranche member cost estimate.
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_poc_cap_cents_check;
ALTER TABLE settings DROP COLUMN IF EXISTS poc_cap_cents;
ALTER TABLE tranches DROP CONSTRAINT IF EXISTS tranches_spend_cap_cents_check;
ALTER TABLE tranches DROP COLUMN IF EXISTS spend_cap_cents;
ALTER TABLE tranche_members DROP COLUMN IF EXISTS est_cost_cents;
