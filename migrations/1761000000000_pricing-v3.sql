-- Up Migration

-- pricing_settings v3 (listing-strategy.md §10.13; CR-001 P1a). Columns only: NO v3 row is seeded.
-- DOM creates v3 with `npm run admin -- pricing-settings new` after Dvir's approval (founder rule 4).
ALTER TABLE pricing_settings
  ADD COLUMN allowed_bins_cents integer[],
  ADD COLUMN nongeo_bin_min_cents integer,
  ADD COLUMN nongeo_default_bin_cents integer,
  ADD COLUMN lander_exception_bins_cents integer[] NOT NULL DEFAULT '{}',
  ADD COLUMN floor_rounding text NOT NULL DEFAULT 'round5' CHECK (floor_rounding IN ('round5','dollar')),
  ADD COLUMN drop_mode text NOT NULL DEFAULT 'pct' CHECK (drop_mode IN ('pct','ladder'));
ALTER TABLE pricing_settings DROP CONSTRAINT pricing_settings_final_push_mode_check;
ALTER TABLE pricing_settings ADD CONSTRAINT pricing_settings_final_push_mode_check
  CHECK (final_push_mode IN ('bin_to_floor_ceil95','bin_to_lowest_listed_ge_floor'));
ALTER TABLE pricing_settings ADD CONSTRAINT pricing_settings_v3_shape CHECK (
  (drop_mode = 'pct' AND allowed_bins_cents IS NULL) OR
  (drop_mode = 'ladder' AND allowed_bins_cents IS NOT NULL AND nongeo_bin_min_cents IS NOT NULL AND nongeo_default_bin_cents IS NOT NULL));

-- Down Migration

-- Append-only table: refuse to drop the v3 columns while a v3 row exists (that would silently turn it into a v2 row).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pricing_settings WHERE allowed_bins_cents IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back pricing-v3: a v3 pricing_settings row exists (append-only)';
  END IF;
END $$;
ALTER TABLE pricing_settings DROP CONSTRAINT pricing_settings_v3_shape;
ALTER TABLE pricing_settings DROP CONSTRAINT pricing_settings_final_push_mode_check;
ALTER TABLE pricing_settings ADD CONSTRAINT pricing_settings_final_push_mode_check CHECK (final_push_mode IN ('bin_to_floor_ceil95'));
ALTER TABLE pricing_settings
  DROP COLUMN drop_mode, DROP COLUMN floor_rounding, DROP COLUMN lander_exception_bins_cents,
  DROP COLUMN nongeo_default_bin_cents, DROP COLUMN nongeo_bin_min_cents, DROP COLUMN allowed_bins_cents;
