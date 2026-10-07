-- Up Migration
-- v2.6.0 (CR-009 N-8): a test set records the sibling method its census used. NULL on sets made before v2.6.0 (read as bt1@v1),
-- plus the features_as_of mode of a rescore ('row' = each name's own as_of, 'now' = the creation instant).
ALTER TABLE public.test_sets ADD COLUMN sibling_method text CHECK (sibling_method IN ('bt1@v1', 'bt1@v2'));
ALTER TABLE public.test_sets ADD COLUMN features_as_of text CHECK (features_as_of IN ('row', 'now'));

-- Down Migration
ALTER TABLE public.test_sets DROP COLUMN features_as_of;
ALTER TABLE public.test_sets DROP COLUMN sibling_method;
