-- Up Migration
-- v3.5.0 (CR-030): purchases made under the small-buy exception to the buy hold are marked, for the rolling 7-day cap.
ALTER TABLE public.purchases ADD COLUMN small_buy_exception boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE public.purchases DROP COLUMN small_buy_exception;
