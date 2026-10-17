-- Up Migration
-- v5.15.0 (tech-debt R4): the NameBio TLDStats copy was written every night and read by nothing (no check, no route); the TLDStats and Verisign
-- paths are no longer allowed either. The table is dropped; namebio_calls keeps its CHECK list (old rows may carry the old kinds until retention removes them).
DROP TABLE public.namebio_tld_stats;

-- Down Migration
CREATE TABLE public.namebio_tld_stats (
    tld text PRIMARY KEY,
    stats jsonb NOT NULL,
    source text NOT NULL DEFAULT 'namebio_free' CHECK (source = 'namebio_free'),
    source_url text NOT NULL,
    fetched_at timestamp with time zone NOT NULL
);
