-- Up Migration
-- v5.78.0 (CR-095 part 2): rebuild the four market_names indexes compactly (92 MB on 29 Oct 2026; the daily fold rewrites nearly every row, each rewrite adding index
-- entries). A separate file (its own transaction) so the space of the dynadot_rows / datasave_pool rebuild is freed first.
REINDEX TABLE public.market_names;

-- Down Migration
SELECT 1;
