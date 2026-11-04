-- Up Migration
-- v6.3.0: the three secondary indexes of market_episodes (the old market_names ones), in their own transaction after the data copy so the peak disk use stays low.
CREATE INDEX market_episodes_name_venue ON public.market_episodes (name, venue);
CREATE INDEX market_episodes_outcome ON public.market_episodes (outcome, outcome_rule, price_band);
CREATE INDEX market_episodes_sale_date ON public.market_episodes (sale_date) WHERE outcome = 'sold';
ANALYZE public.market_episodes;
ANALYZE public.market_episode_seen;

-- Down Migration
DROP INDEX public.market_episodes_name_venue;
DROP INDEX public.market_episodes_outcome;
DROP INDEX public.market_episodes_sale_date;
