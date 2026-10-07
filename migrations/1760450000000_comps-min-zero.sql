-- Up Migration
-- Pricing settings v3 (Dvir, 2026-10-07 11:23 IDT, CR-004 step 2): "comps optional" → comps_min may be 0.
ALTER TABLE pricing_settings DROP CONSTRAINT pricing_settings_comps_min_check;
ALTER TABLE pricing_settings ADD CONSTRAINT pricing_settings_comps_min_check CHECK (comps_min >= 0);

-- Down Migration
ALTER TABLE pricing_settings DROP CONSTRAINT pricing_settings_comps_min_check;
ALTER TABLE pricing_settings ADD CONSTRAINT pricing_settings_comps_min_check CHECK (comps_min >= 1);
