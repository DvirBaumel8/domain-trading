-- Up Migration
-- v1 listing settings moved to pricing_settings (geo range) or retired (high-value guard) on 5 Oct 2026 (listing-strategy.md §5 Settings)
ALTER TABLE settings
  DROP COLUMN geo_bin_min_cents,
  DROP COLUMN geo_bin_max_cents,
  DROP COLUMN high_value_categories,
  DROP COLUMN high_value_guard_modes;

-- Down Migration
ALTER TABLE settings
  ADD COLUMN geo_bin_min_cents integer NOT NULL DEFAULT 29900,
  ADD COLUMN geo_bin_max_cents integer NOT NULL DEFAULT 49900,
  ADD COLUMN high_value_categories text[] NOT NULL DEFAULT '{trend,b2b,collision,regulation,buzzword}',
  ADD COLUMN high_value_guard_modes text[] NOT NULL DEFAULT '{bin}',
  ADD CHECK (geo_bin_min_cents > 0 AND geo_bin_min_cents <= geo_bin_max_cents),
  ADD CHECK (high_value_guard_modes <@ ARRAY['bin', 'offer', 'hybrid']),
  ADD CHECK (high_value_categories <@ ARRAY['geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other']);
