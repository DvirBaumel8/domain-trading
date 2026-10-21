-- Up Migration
-- v5.33.0 (CR-073a PP-V2): each pick-proof day records the recipe version it was frozen with. Days frozen before this release are pickproof-v1
-- (their stored is_two_word flags and hashes stay); every day frozen from now on is pickproof-v2 (the stricter two-word rule). ADD COLUMN with a
-- default fills existing rows without firing the sealed-day row trigger.
ALTER TABLE public.pickproof_days ADD COLUMN recipe_version text NOT NULL DEFAULT 'pickproof-v1' CHECK (recipe_version IN ('pickproof-v1', 'pickproof-v2'));

-- Down Migration
ALTER TABLE public.pickproof_days DROP COLUMN recipe_version;
