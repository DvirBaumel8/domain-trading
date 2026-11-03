-- Up Migration
-- v6.2.0 (CR-100 ask 4): market_names gets fillfactor 80, so each heap page keeps about 20% free for HOT updates. The daily "continue" UPDATE in
-- src/modules/market/episodes.ts sets only seen_days, price_changes, list_price_cents_last, last_seen, days_listed, source_sha256 and derived_at, and none of
-- those is in an index (the four indexes are: the primary key episode_id; (name, venue); (outcome, outcome_rule, price_band); and sale_date where outcome = 'sold').
-- With room on the page such an update stays on the same page and adds no index entries, so the indexes stop growing with every daily fold.
-- It applies to pages written from now on (existing pages are not rewritten: a full rewrite is barred by the CR-095 headroom rule).
ALTER TABLE public.market_names SET (fillfactor = 80);

-- Down Migration
ALTER TABLE public.market_names RESET (fillfactor);
