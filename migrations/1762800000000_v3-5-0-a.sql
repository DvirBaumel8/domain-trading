-- Up Migration
-- v3.5.0 (CR-029 A): a burst day may allow up to 6 posts (the launch: post 1 + 5 more on one day).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.posting_bursts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%cap%' LOOP
    EXECUTE format('ALTER TABLE public.posting_bursts DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.posting_bursts ADD CONSTRAINT posting_bursts_cap_check CHECK (cap BETWEEN 2 AND 6);

-- Down Migration
ALTER TABLE public.posting_bursts DROP CONSTRAINT posting_bursts_cap_check;
ALTER TABLE public.posting_bursts ADD CONSTRAINT posting_bursts_cap_check CHECK (cap BETWEEN 2 AND 5) NOT VALID;
