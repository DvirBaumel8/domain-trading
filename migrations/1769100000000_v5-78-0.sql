-- Up Migration
-- v5.78.0 (CR-095 part 2): free index space on the two daily-churn tables, from /health.db_size.tables (29 Oct 2026: dynadot_rows heap 80 MB / indexes 124 MB,
-- datasave_pool heap 30 MB / index 55 MB).
-- 1. dynadot_rows_domain_lookup (domain) is not used: every read of dynadot_rows names data_date and kind (checked in src), which the two unique indexes serve.
-- 2. datasave_pool: scorePool rewrites filter_code / score / score_reason / scored_at of every closeout row; with full pages each rewrite adds a new entry to the
--    primary key. fillfactor 70 leaves room on new pages so those updates stay on the page (HOT) and skip the index. The pool keeps 2-3 data dates, so every page is new within days.
-- 3. REINDEX rebuilds the remaining indexes compactly (each file is one transaction; the extra space is only the new indexes, about 80 MB, freed at commit).
DROP INDEX public.dynadot_rows_domain_lookup;
ALTER TABLE public.datasave_pool SET (fillfactor = 70);
REINDEX TABLE public.datasave_pool;
REINDEX TABLE public.dynadot_rows;

-- Down Migration
ALTER TABLE public.datasave_pool RESET (fillfactor);
CREATE INDEX dynadot_rows_domain_lookup ON public.dynadot_rows (domain);
