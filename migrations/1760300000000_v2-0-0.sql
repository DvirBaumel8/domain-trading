-- Up Migration
-- v2.0.0: a real /buy must come from an open tranche; the purchase row records which one (nullable: v1 purchases and imports have none).
ALTER TABLE public.purchases ADD COLUMN tranche_id text REFERENCES public.tranches(id);
CREATE INDEX purchases_tranche_idx ON public.purchases (tranche_id) WHERE tranche_id IS NOT NULL;

-- Down Migration
DROP INDEX public.purchases_tranche_idx;
ALTER TABLE public.purchases DROP COLUMN tranche_id;
