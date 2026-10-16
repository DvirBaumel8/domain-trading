-- Up Migration
-- v5.8.0 (CR-059): Line 2 (S8 aftermarket import lane). Caps change only by migration (founder rule 2).
-- domains.lane: NULL = Line 1 (hand registration), 'S8' = Line 2 (names Dvir bought on a registrar website, imported by POST /portfolio/import).
-- settings.s8_max_price_cents: the most one S8 name may have cost (Dvir, 15 Oct 2026: "50$ limit only"; no money total, G-86).
-- settings.s8_reserved_slots: of the max_domains names, this many are reserved for S8; Line 1 may fill only max_domains - s8_reserved_slots.
ALTER TABLE public.domains ADD COLUMN lane text CONSTRAINT domains_lane_check CHECK (lane IS NULL OR lane = 'S8');
ALTER TABLE public.settings ADD COLUMN s8_max_price_cents integer NOT NULL DEFAULT 5000 CONSTRAINT settings_s8_max_price_check CHECK (s8_max_price_cents > 0);
ALTER TABLE public.settings ADD COLUMN s8_reserved_slots integer NOT NULL DEFAULT 10 CONSTRAINT settings_s8_reserved_slots_check CHECK (s8_reserved_slots >= 0 AND s8_reserved_slots <= max_domains);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN s8_reserved_slots;
ALTER TABLE public.settings DROP COLUMN s8_max_price_cents;
ALTER TABLE public.domains DROP COLUMN lane;
