-- Up Migration
-- v6.3.0 (CR-100): free disk before the market_names split copies the table (next file). A file is one transaction, and a dropped index's space is freed at its
-- commit, so dropping the three secondary indexes here (46 MB on 4 Nov 2026) lowers the copy's peak. Nothing reads market_names between the two files:
-- start.sh runs every migration before the server starts. The split builds the same three indexes on the new cold table (1769400000001_v6-3-0-indexes.sql).
DROP INDEX public.market_names_name_venue;
DROP INDEX public.market_names_outcome;
DROP INDEX public.market_names_sale_date;

-- Down Migration
CREATE INDEX market_names_name_venue ON public.market_names (name, venue);
CREATE INDEX market_names_outcome ON public.market_names (outcome, outcome_rule, price_band);
CREATE INDEX market_names_sale_date ON public.market_names (sale_date) WHERE outcome = 'sold';
