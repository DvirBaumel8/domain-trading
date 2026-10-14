-- Up Migration
-- v5.3.0 (CR-053): scout lessons. One row per learned pattern from a rejected near-miss; mutable (merge appends to notes, PATCH edits three fields).
-- Not append-only and not in the backup export (a lessons file lives with Gavriel; CR-053).
CREATE TABLE public.scout_lessons (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  scout text NOT NULL CHECK (scout IN ('tzofeh-geo', 'rules', 'signals', 'drops', 'other')),
  sector text NOT NULL CHECK (sector IN ('S2', 'S3', 'S4', 'S6', 'S7', 'cross')),
  domains text[] NOT NULL DEFAULT '{}',
  rule text NOT NULL CHECK (rule = lower(rule) AND char_length(rule) BETWEEN 1 AND 20),
  lesson text NOT NULL CHECK (char_length(lesson) BETWEEN 1 AND 300),
  notes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notes) = 'array' AND jsonb_array_length(notes) <= 20),
  recheck_if text NOT NULL DEFAULT 'never' CHECK (char_length(recheck_if) BETWEEN 1 AND 200),
  source_file text CHECK (source_file IS NULL OR char_length(source_file) <= 200),
  superseded_by text REFERENCES public.scout_lessons (id),
  created_by text NOT NULL
);
CREATE INDEX scout_lessons_domains_idx ON public.scout_lessons USING gin (domains);
CREATE INDEX scout_lessons_sector_rule_idx ON public.scout_lessons (sector, rule, created_at DESC);
CREATE INDEX scout_lessons_created_idx ON public.scout_lessons (created_at DESC, id DESC);

-- Down Migration
DROP TABLE public.scout_lessons;
