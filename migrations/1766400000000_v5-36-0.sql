-- Up Migration
-- v5.36.0: the S8 per-name price cap goes from $50 to $250 (Dvir, 25 Oct 2026: "Let's raise the limit to 250 and make the auctions our main effort").
-- Caps change only by migration (founder rule 2).
ALTER TABLE public.settings ALTER COLUMN s8_max_price_cents SET DEFAULT 25000;
UPDATE public.settings SET s8_max_price_cents = 25000;

-- Down Migration
ALTER TABLE public.settings ALTER COLUMN s8_max_price_cents SET DEFAULT 5000;
UPDATE public.settings SET s8_max_price_cents = 5000;
