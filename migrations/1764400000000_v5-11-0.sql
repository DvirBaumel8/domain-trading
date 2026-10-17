-- Up Migration
-- v5.11.0 (CR-062): NameBio free endpoints only (RetailStats, TLDStats, Verisign), with attribution.
-- Keyword aggregates, never per-sale rows: nothing here ever goes into engine_sales (CR-062 R-5).
CREATE TABLE public.namebio_keyword_stats (
    keyword text PRIMARY KEY,
    -- {exact|start|end|middle: {sale_count, price_sum, price_avg, price_max, price_stddev}}; a placement NameBio did not return is absent
    placements jsonb NOT NULL,
    source text NOT NULL DEFAULT 'namebio_free' CHECK (source = 'namebio_free'),
    source_url text NOT NULL,
    fetched_at timestamp with time zone NOT NULL
);
CREATE TABLE public.namebio_tld_stats (
    tld text PRIMARY KEY,
    stats jsonb NOT NULL,
    source text NOT NULL DEFAULT 'namebio_free' CHECK (source = 'namebio_free'),
    source_url text NOT NULL,
    fetched_at timestamp with time zone NOT NULL
);
-- One row per request sent to a rate-limited NameBio endpoint, so a restart does not reset the limits (4 a minute, Verisign 5 per 24 h).
CREATE TABLE public.namebio_calls (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('retailstats', 'tldstats', 'verisign', 'verisign_file')),
    called_at timestamp with time zone NOT NULL
);
CREATE INDEX namebio_calls_kind_at ON public.namebio_calls (kind, called_at);

-- Down Migration
DROP TABLE public.namebio_calls;
DROP TABLE public.namebio_tld_stats;
DROP TABLE public.namebio_keyword_stats;
