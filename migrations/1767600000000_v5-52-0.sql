-- Up Migration
-- v5.52.0 (Dvir, 26 Oct 2026: "No need to limit ourselves to 30 and 10. If we will find good names we will buy it. Remove this limitation please.").
-- The 40-name cap (settings.max_domains, founder rule 2) is now shared by Line 1 and S8; the 10 slots reserved for S8 (CR-059) are gone.
ALTER TABLE public.settings DROP COLUMN s8_reserved_slots;

-- Down Migration
ALTER TABLE public.settings ADD COLUMN s8_reserved_slots integer NOT NULL DEFAULT 10 CONSTRAINT settings_s8_reserved_slots_check CHECK (s8_reserved_slots >= 0 AND s8_reserved_slots <= max_domains);
