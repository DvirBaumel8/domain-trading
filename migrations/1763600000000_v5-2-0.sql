-- Up Migration
-- v5.2.0 (CR-057, Dvir 14 Oct 2026): X posting removed. The post tables are dropped (their triggers go with them); the posts_guard function too.
-- audit_log is not touched: every post's creation and changes stay there.
DROP TABLE public.post_allowance_exclusions;
DROP TABLE public.post_images;
DROP TABLE public.posting_bursts;
DROP TABLE public.posting_switches;
DROP TABLE public.posts;
DROP FUNCTION public.posts_guard();

-- Down Migration
-- Not reversible: the posting feature is gone from the code, so the tables are not recreated.
