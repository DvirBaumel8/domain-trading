-- Up Migration
-- v6.3.0 (CR-100 follow-up, production DB at 74% of the Neon free limit): market_names is split so the daily fold stops rewriting a wide row.
--   market_episodes      the cold, wide part: everything that changes only when an episode is created or its label/source changes.
--   market_episode_seen  the hot, narrow part: last_seen, seen_days, list_price_cents_last, price_changes. Only its primary key is indexed (never updated),
--                        fillfactor 50, so the daily "continue" UPDATE is a HOT update in place and adds no row versions to the wide table.
--   market_names         now a VIEW with exactly the old columns (days_listed = last_seen - first_seen; source_sha256 of a Dynadot Buy-Now row = the sha of the
--                        complete dynadot_aftermarket manifest of its last_seen day, stored NULL in the cold table). INSTEAD OF triggers keep every other writer working.
-- Disk: this file copies the data and drops the old table; the three secondary indexes are built by the next file (its own transaction) so the peak never holds
-- the old table, the new table and all new indexes at once. A derived_at of an unchanged episode is no longer bumped by the daily continue (see market.md).

CREATE TABLE public.market_episodes (
  id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  episode_id text PRIMARY KEY CHECK (episode_id ~ '^[0-9a-f]{40}$'),
  name text NOT NULL CHECK (name = lower(name)),
  sld text NOT NULL,
  tld text NOT NULL,
  venue text NOT NULL,
  listing_type text NOT NULL CHECK (listing_type IN ('bin', 'offer', 'auction', 'closeout')),
  list_price_cents_first bigint CHECK (list_price_cents_first IS NULL OR list_price_cents_first >= 0),
  first_seen date NOT NULL,
  sale_only boolean NOT NULL DEFAULT false,
  outcome text NOT NULL CHECK (outcome IN ('sold', 'unsold', 'unknown', 'delisted')),
  outcome_rule text NOT NULL,
  sale_price_cents bigint CHECK (sale_price_cents IS NULL OR sale_price_cents > 0),
  sale_date date,
  source text NOT NULL,
  source_url text,
  source_sha256 text,
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C', 'D')),
  feat_asof date,
  dup_group text,
  dup_sources text[],
  price_band text NOT NULL CHECK (price_band IN ('500-999', '1k-2.5k', '2.5k-5k', '5k-10k', '10k+')),
  sale_id bigint REFERENCES public.market_sales (id),
  derived_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'sold') = (sale_price_cents IS NOT NULL AND sale_date IS NOT NULL))
);

CREATE TABLE public.market_episode_seen (
  id bigint PRIMARY KEY REFERENCES public.market_episodes (id) ON DELETE CASCADE,
  last_seen date NOT NULL,
  seen_days integer NOT NULL DEFAULT 0 CHECK (seen_days >= 0),
  list_price_cents_last bigint CHECK (list_price_cents_last IS NULL OR list_price_cents_last >= 0),
  price_changes integer NOT NULL DEFAULT 0 CHECK (price_changes >= 0)
) WITH (fillfactor = 50);
-- last_seen >= first_seen is enforced by the writers (episodes.ts, the view triggers below) and tested (EP-63-*): a trigger on the hot path would cost a lookup per row.

ALTER TABLE public.market_names RENAME TO market_names_old;

INSERT INTO public.market_episodes (episode_id, name, sld, tld, venue, listing_type, list_price_cents_first, first_seen, sale_only, outcome, outcome_rule, sale_price_cents, sale_date,
  source, source_url, source_sha256, tier, feat_asof, dup_group, dup_sources, price_band, sale_id, derived_at)
SELECT o.episode_id, o.name, o.sld, o.tld, o.venue, o.listing_type, o.list_price_cents_first, o.first_seen, o.sale_only, o.outcome, o.outcome_rule, o.sale_price_cents, o.sale_date,
  o.source, o.source_url,
  -- a Buy-Now row whose stored sha is the manifest sha of its last_seen day is derived by the view instead (NULL here); anything else stays stored
  CASE WHEN o.source = 'dynadot_aftermarket' AND o.venue = 'dynadot' AND o.listing_type = 'bin' AND o.source_sha256 IS NOT NULL
        AND o.source_sha256 = (SELECT m.sha256 FROM public.snapshot_manifests m WHERE m.source = 'dynadot_aftermarket' AND m.data_date = o.last_seen AND m.status = 'complete' ORDER BY m.id LIMIT 1)
       THEN NULL ELSE o.source_sha256 END,
  o.tier, o.feat_asof, o.dup_group, o.dup_sources, o.price_band, o.sale_id, o.derived_at
FROM public.market_names_old o ORDER BY o.episode_id;

INSERT INTO public.market_episode_seen (id, last_seen, seen_days, list_price_cents_last, price_changes)
SELECT c.id, o.last_seen, o.seen_days, o.list_price_cents_last, o.price_changes
FROM public.market_episodes c JOIN public.market_names_old o ON o.episode_id = c.episode_id ORDER BY c.id;

DROP TABLE public.market_names_old;

CREATE VIEW public.market_names AS
SELECT c.episode_id, c.name, c.sld, c.tld, c.venue, c.listing_type, c.list_price_cents_first, h.list_price_cents_last, h.price_changes, c.first_seen, h.last_seen,
  (h.last_seen - c.first_seen) AS days_listed, h.seen_days, c.sale_only, c.outcome, c.outcome_rule, c.sale_price_cents, c.sale_date, c.source, c.source_url,
  COALESCE(c.source_sha256, CASE WHEN c.source = 'dynadot_aftermarket' THEN
    (SELECT m.sha256 FROM public.snapshot_manifests m WHERE m.source = 'dynadot_aftermarket' AND m.data_date = h.last_seen AND m.status = 'complete' ORDER BY m.id LIMIT 1) END) AS source_sha256,
  c.tier, c.feat_asof, c.dup_group, c.dup_sources, c.price_band, c.sale_id, c.derived_at
FROM public.market_episodes c JOIN public.market_episode_seen h ON h.id = c.id;
-- the defaults the old table had, for INSERTs through the view
ALTER VIEW public.market_names ALTER COLUMN price_changes SET DEFAULT 0;
ALTER VIEW public.market_names ALTER COLUMN seen_days SET DEFAULT 0;
ALTER VIEW public.market_names ALTER COLUMN sale_only SET DEFAULT false;
ALTER VIEW public.market_names ALTER COLUMN derived_at SET DEFAULT now();

CREATE FUNCTION public.market_names_ins() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  IF NEW.last_seen < NEW.first_seen THEN RAISE EXCEPTION 'market_names: last_seen % is before first_seen %', NEW.last_seen, NEW.first_seen; END IF;
  INSERT INTO public.market_episodes (episode_id, name, sld, tld, venue, listing_type, list_price_cents_first, first_seen, sale_only, outcome, outcome_rule, sale_price_cents, sale_date,
    source, source_url, source_sha256, tier, feat_asof, dup_group, dup_sources, price_band, sale_id, derived_at)
  VALUES (NEW.episode_id, NEW.name, NEW.sld, NEW.tld, NEW.venue, NEW.listing_type, NEW.list_price_cents_first, NEW.first_seen, COALESCE(NEW.sale_only, false), NEW.outcome, NEW.outcome_rule,
    NEW.sale_price_cents, NEW.sale_date, NEW.source, NEW.source_url, NEW.source_sha256, NEW.tier, NEW.feat_asof, NEW.dup_group, NEW.dup_sources, NEW.price_band, NEW.sale_id, COALESCE(NEW.derived_at, now()))
  RETURNING id INTO v_id;
  INSERT INTO public.market_episode_seen (id, last_seen, seen_days, list_price_cents_last, price_changes)
  VALUES (v_id, NEW.last_seen, COALESCE(NEW.seen_days, 0), NEW.list_price_cents_last, COALESCE(NEW.price_changes, 0));
  NEW.days_listed := NEW.last_seen - NEW.first_seen;
  RETURN NEW;
END
$$;
CREATE TRIGGER market_names_ins INSTEAD OF INSERT ON public.market_names FOR EACH ROW EXECUTE FUNCTION public.market_names_ins();

CREATE FUNCTION public.market_names_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_seen < NEW.first_seen THEN RAISE EXCEPTION 'market_names: last_seen % is before first_seen %', NEW.last_seen, NEW.first_seen; END IF;
  UPDATE public.market_episodes c SET episode_id = NEW.episode_id, name = NEW.name, sld = NEW.sld, tld = NEW.tld, venue = NEW.venue, listing_type = NEW.listing_type,
    list_price_cents_first = NEW.list_price_cents_first, first_seen = NEW.first_seen, sale_only = NEW.sale_only, outcome = NEW.outcome, outcome_rule = NEW.outcome_rule,
    sale_price_cents = NEW.sale_price_cents, sale_date = NEW.sale_date, source = NEW.source, source_url = NEW.source_url,
    source_sha256 = CASE WHEN NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256 THEN NEW.source_sha256 ELSE c.source_sha256 END,
    tier = NEW.tier, feat_asof = NEW.feat_asof, dup_group = NEW.dup_group, dup_sources = NEW.dup_sources, price_band = NEW.price_band, sale_id = NEW.sale_id, derived_at = NEW.derived_at
  WHERE c.episode_id = OLD.episode_id
    AND (c.episode_id, c.name, c.sld, c.tld, c.venue, c.listing_type, c.list_price_cents_first, c.first_seen, c.sale_only, c.outcome, c.outcome_rule, c.sale_price_cents, c.sale_date, c.source,
         c.source_url, c.source_sha256, c.tier, c.feat_asof, c.dup_group, c.dup_sources, c.price_band, c.sale_id, c.derived_at)
      IS DISTINCT FROM (NEW.episode_id, NEW.name, NEW.sld, NEW.tld, NEW.venue, NEW.listing_type, NEW.list_price_cents_first, NEW.first_seen, NEW.sale_only, NEW.outcome, NEW.outcome_rule,
         NEW.sale_price_cents, NEW.sale_date, NEW.source, NEW.source_url,
         CASE WHEN NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256 THEN NEW.source_sha256 ELSE c.source_sha256 END,
         NEW.tier, NEW.feat_asof, NEW.dup_group, NEW.dup_sources, NEW.price_band, NEW.sale_id, NEW.derived_at);
  UPDATE public.market_episode_seen h SET last_seen = NEW.last_seen, seen_days = NEW.seen_days, list_price_cents_last = NEW.list_price_cents_last, price_changes = NEW.price_changes
  FROM public.market_episodes c
  WHERE c.episode_id = NEW.episode_id AND h.id = c.id
    AND (h.last_seen, h.seen_days, h.list_price_cents_last, h.price_changes) IS DISTINCT FROM (NEW.last_seen, NEW.seen_days, NEW.list_price_cents_last, NEW.price_changes);
  NEW.days_listed := NEW.last_seen - NEW.first_seen;
  RETURN NEW;
END
$$;
CREATE TRIGGER market_names_upd INSTEAD OF UPDATE ON public.market_names FOR EACH ROW EXECUTE FUNCTION public.market_names_upd();

CREATE FUNCTION public.market_names_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.market_episodes WHERE episode_id = OLD.episode_id;
  RETURN OLD;
END
$$;
CREATE TRIGGER market_names_del INSTEAD OF DELETE ON public.market_names FOR EACH ROW EXECUTE FUNCTION public.market_names_del();

-- Down Migration
-- Best effort: the view's rows go back into one wide table (the old four indexes are rebuilt). Data is kept.
CREATE TABLE public.market_names_old AS SELECT * FROM public.market_names;
DROP VIEW public.market_names;
DROP FUNCTION public.market_names_ins();
DROP FUNCTION public.market_names_upd();
DROP FUNCTION public.market_names_del();
DROP TABLE public.market_episode_seen;
DROP TABLE public.market_episodes;
ALTER TABLE public.market_names_old RENAME TO market_names;
ALTER TABLE public.market_names ADD PRIMARY KEY (episode_id);
ALTER TABLE public.market_names ADD FOREIGN KEY (sale_id) REFERENCES public.market_sales (id);
ALTER TABLE public.market_names ADD CHECK (last_seen >= first_seen);
ALTER TABLE public.market_names ADD CHECK ((outcome = 'sold') = (sale_price_cents IS NOT NULL AND sale_date IS NOT NULL));
CREATE INDEX market_names_name_venue ON public.market_names (name, venue);
CREATE INDEX market_names_outcome ON public.market_names (outcome, outcome_rule, price_band);
CREATE INDEX market_names_sale_date ON public.market_names (sale_date) WHERE outcome = 'sold';
ALTER TABLE public.market_names SET (fillfactor = 80);
