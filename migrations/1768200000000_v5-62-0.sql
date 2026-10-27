-- Up Migration
-- v5.62.0 (CR-080 item 3): the server reads Dynadot itself (read-only restricted key). A manifest written by the server has origin 'server';
-- a day the server found collapsed (R-8 / R-8v2 panel GAP) is recorded as status 'gap' (never sealed, no rows stored).
ALTER TABLE public.snapshot_manifests DROP CONSTRAINT snapshot_manifests_origin_check;
ALTER TABLE public.snapshot_manifests ADD CONSTRAINT snapshot_manifests_origin_check CHECK (origin IN ('fetch', 'bot_upload', 'server'));
ALTER TABLE public.snapshot_manifests DROP CONSTRAINT snapshot_manifests_status_check;
ALTER TABLE public.snapshot_manifests ADD CONSTRAINT snapshot_manifests_status_check CHECK (status IN ('complete', 'partial', 'error', 'not_configured', 'gap'));

-- Down Migration
DELETE FROM public.snapshot_manifests WHERE status = 'gap' OR origin = 'server';
ALTER TABLE public.snapshot_manifests DROP CONSTRAINT snapshot_manifests_status_check;
ALTER TABLE public.snapshot_manifests ADD CONSTRAINT snapshot_manifests_status_check CHECK (status IN ('complete', 'partial', 'error', 'not_configured'));
ALTER TABLE public.snapshot_manifests DROP CONSTRAINT snapshot_manifests_origin_check;
ALTER TABLE public.snapshot_manifests ADD CONSTRAINT snapshot_manifests_origin_check CHECK (origin IN ('fetch', 'bot_upload'));
