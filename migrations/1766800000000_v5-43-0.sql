-- Up Migration
-- v5.43.0 (CR-078 phase 1, G-132): the knowledge base. Plain storage and plain-code verdicts, no AI (founder rule 9).
-- Append-only (reject_mutation): kb_authors, kb_sources, kb_claims, kb_evidence, kb_source_links, kb_questions, kb_verdicts, kb_settings.
-- A correction is a new row of the same natural key with version + 1 and `supersedes` = the id of the row it replaces; reads use the highest version.

-- Versioned weights, half-lives per topic and thresholds (research §2.3). Changed by migration or admin command only; never hard-coded in logic.
CREATE TABLE public.kb_settings (
  version integer PRIMARY KEY CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  note text,
  "values" jsonb NOT NULL
);
CREATE TRIGGER kb_settings_append_only BEFORE DELETE OR UPDATE ON public.kb_settings FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER kb_settings_no_truncate BEFORE TRUNCATE ON public.kb_settings FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
-- The topic list lives in the settings row ("values"."topics"), so a new topic is a new settings version (not a table change); the routes check it.
INSERT INTO public.kb_settings (version, note, "values") VALUES (1, 'research knowledge-sources-2026-10 §2.3 (CR-078)', $json$
{
  "topics": ["sell_through", "price_bands", "auction_tactics", "buyer_types", "name_shape", "extensions", "renewal_economics", "safety_trademark", "safety_history", "marketplaces", "platform_rules", "other"],
  "half_life_days": {"sell_through": 1095, "buyer_types": 1095, "price_bands": 730, "auction_tactics": 730, "name_shape": 1095, "extensions": 730, "renewal_economics": 730, "safety_trademark": 730, "safety_history": 730, "marketplaces": 365, "platform_rules": 180, "other": 730},
  "grade_weight": {"A": 1.0, "B": 0.6, "C": 0.25, "D": 0, "F": 0},
  "credibility_weight": {"1": 1.0, "2": 0.8, "3": 0.5, "4": 0.2, "5": 0.3},
  "sample": {"log_divisor": 3, "fixed_unmeasured": 0.3, "single_reported_sale": 0.1},
  "kind_weight": {"measured": 1.0, "reported_sale": 0.8, "experience": 0.6, "opinion": 0.4},
  "thresholds": {
    "inconsistency_agreement": 0.75,
    "min_clusters": 3,
    "min_ab_clusters": 2,
    "imprecision_total_n": 1.0,
    "bias_share": 0.5,
    "indirect_share": 0.5,
    "stale_mean_r": 0.5,
    "step_up_agreement": 0.9,
    "step_up_min_a_clusters": 2,
    "high_agreement": 0.9,
    "high_min_a_clusters": 2,
    "recheck_r": 0.5,
    "echo_jaccard": 0.5
  }
}
$json$::jsonb);

CREATE TABLE public.kb_authors (
  id bigserial PRIMARY KEY,
  name_key text NOT NULL CHECK (name_key = lower(btrim(name_key)) AND char_length(name_key) BETWEEN 1 AND 120),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes bigint REFERENCES public.kb_authors (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  handles jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen date,
  verified_sales_count integer CHECK (verified_sales_count IS NULL OR verified_sales_count >= 0),
  verified_sales_source text CHECK (verified_sales_source IS NULL OR char_length(verified_sales_source) <= 300),
  years_active double precision CHECK (years_active IS NULL OR years_active >= 0),
  track_score double precision CHECK (track_score IS NULL OR (track_score >= 0 AND track_score <= 1)),
  grade text NOT NULL DEFAULT 'F' CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  grade_reason text CHECK (grade_reason IS NULL OR char_length(grade_reason) <= 400),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name_key, version),
  CHECK ((version = 1) = (supersedes IS NULL)),
  CHECK (grade = 'F' OR char_length(btrim(coalesce(grade_reason, ''))) > 0)
);
CREATE UNIQUE INDEX kb_authors_supersedes_idx ON public.kb_authors (supersedes) WHERE supersedes IS NOT NULL;

CREATE TABLE public.kb_sources (
  id bigserial PRIMARY KEY,
  url text NOT NULL CHECK (char_length(url) BETWEEN 8 AND 1000),
  url_hash text NOT NULL CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes bigint REFERENCES public.kb_sources (id),
  publisher text CHECK (publisher IS NULL OR char_length(publisher) <= 200),
  author_id bigint REFERENCES public.kb_authors (id),
  title text CHECK (title IS NULL OR char_length(title) <= 400),
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  type text NOT NULL CHECK (type IN ('official_data', 'paper', 'dataset', 'news', 'practitioner_blog', 'forum_post', 'video', 'comment', 'vendor', 'aggregator', 'own_analysis')),
  access_method text NOT NULL DEFAULT 'manual' CHECK (access_method IN ('rss', 'api', 'session_web', 'manual')),
  access_note text CHECK (access_note IS NULL OR char_length(access_note) <= 300),
  reliability text NOT NULL DEFAULT 'F' CHECK (reliability IN ('A', 'B', 'C', 'D', 'F')),
  reliability_reason text CHECK (reliability_reason IS NULL OR char_length(reliability_reason) <= 400),
  conflict_of_interest text NOT NULL DEFAULT 'unknown' CHECK (conflict_of_interest IN ('none', 'sells_service', 'sells_names', 'marketplace', 'unknown')),
  excerpt text CHECK (excerpt IS NULL OR char_length(excerpt) <= 300),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  minhash text CHECK (minhash IS NULL OR (char_length(minhash) = 512 AND minhash ~ '^[0-9a-f]+$')),
  topics text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'lead' CHECK (status IN ('lead', 'read', 'graded', 'rejected')),
  rejected_reason text CHECK (rejected_reason IS NULL OR char_length(rejected_reason) <= 200),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (url_hash, version),
  CHECK ((version = 1) = (supersedes IS NULL)),
  CHECK (reliability = 'F' OR char_length(btrim(coalesce(reliability_reason, ''))) > 0),
  CHECK (status <> 'graded' OR reliability <> 'F'),
  CHECK (status <> 'rejected' OR char_length(btrim(coalesce(rejected_reason, ''))) > 0)
);
CREATE UNIQUE INDEX kb_sources_supersedes_idx ON public.kb_sources (supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX kb_sources_status_idx ON public.kb_sources (status);

CREATE TABLE public.kb_questions (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  population text CHECK (population IS NULL OR char_length(population) <= 300),
  decision_owner text CHECK (decision_owner IS NULL OR char_length(decision_owner) <= 80),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.kb_claims (
  id bigserial PRIMARY KEY,
  claim_key text NOT NULL CHECK (claim_key = lower(claim_key) AND char_length(claim_key) BETWEEN 5 AND 600),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes bigint REFERENCES public.kb_claims (id),
  topic text NOT NULL CHECK (topic ~ '^[a-z_]{2,40}$'),
  question_ids integer[] NOT NULL DEFAULT '{}',
  option text CHECK (option IS NULL OR char_length(option) <= 120),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 400),
  variable text NOT NULL CHECK (char_length(variable) BETWEEN 1 AND 200),
  direction text NOT NULL CHECK (direction IN ('increases', 'decreases', 'no_effect', 'value')),
  effect_value double precision,
  effect_unit text CHECK (effect_unit IS NULL OR char_length(effect_unit) <= 40),
  effect_low double precision,
  effect_high double precision,
  population text NOT NULL CHECK (char_length(population) BETWEEN 1 AND 300),
  date_range_start date,
  date_range_end date,
  half_life_days integer CHECK (half_life_days IS NULL OR half_life_days BETWEEN 1 AND 3650),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_key, version),
  CHECK ((version = 1) = (supersedes IS NULL)),
  CHECK (date_range_start IS NULL OR date_range_end IS NULL OR date_range_start <= date_range_end)
);
CREATE UNIQUE INDEX kb_claims_supersedes_idx ON public.kb_claims (supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX kb_claims_topic_idx ON public.kb_claims (topic);

CREATE TABLE public.kb_evidence (
  id bigserial PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES public.kb_sources (id),
  claim_id bigint NOT NULL REFERENCES public.kb_claims (id),
  locator text NOT NULL DEFAULT '' CHECK (char_length(locator) <= 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes bigint REFERENCES public.kb_evidence (id),
  stance text NOT NULL CHECK (stance IN ('supports', 'contradicts', 'qualifies')),
  credibility smallint NOT NULL CHECK (credibility BETWEEN 1 AND 5),
  sample_size integer CHECK (sample_size IS NULL OR sample_size >= 0),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('measured', 'reported_sale', 'experience', 'opinion')),
  population_match text NOT NULL DEFAULT 'direct' CHECK (population_match IN ('direct', 'indirect')),
  survivorship boolean NOT NULL DEFAULT false,
  claim_grade text CHECK (claim_grade IS NULL OR claim_grade IN ('A', 'B', 'C', 'D', 'F')),
  effect_value double precision,
  quote text CHECK (quote IS NULL OR char_length(quote) <= 200),
  extracted_by text NOT NULL,
  extracted_at timestamptz NOT NULL,
  extraction_check text NOT NULL DEFAULT 'single' CHECK (extraction_check IN ('single', 'double_agreed', 'double_conflict')),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, claim_id, locator, version),
  CHECK ((version = 1) = (supersedes IS NULL))
);
CREATE UNIQUE INDEX kb_evidence_supersedes_idx ON public.kb_evidence (supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX kb_evidence_claim_idx ON public.kb_evidence (claim_id);

CREATE TABLE public.kb_source_links (
  id bigserial PRIMARY KEY,
  from_source_id bigint NOT NULL REFERENCES public.kb_sources (id),
  to_source_id bigint NOT NULL REFERENCES public.kb_sources (id),
  kind text NOT NULL CHECK (kind IN ('echo_of', 'cites', 'same_author', 'syndicated', 'aggregator_of')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes bigint REFERENCES public.kb_source_links (id),
  retracted boolean NOT NULL DEFAULT false,
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_source_id, to_source_id, kind, version),
  CHECK (from_source_id <> to_source_id),
  CHECK ((version = 1) = (supersedes IS NULL)),
  CHECK (kind <> 'same_author' OR char_length(btrim(coalesce(note, ''))) > 0)
);
CREATE UNIQUE INDEX kb_source_links_supersedes_idx ON public.kb_source_links (supersedes) WHERE supersedes IS NOT NULL;

CREATE TABLE public.kb_verdicts (
  id bigserial PRIMARY KEY,
  question_id bigint NOT NULL REFERENCES public.kb_questions (id),
  computed_at timestamptz NOT NULL,
  settings_version integer NOT NULL REFERENCES public.kb_settings (version),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  verdict jsonb NOT NULL,
  certainty text NOT NULL CHECK (certainty IN ('high', 'moderate', 'low', 'very_low')),
  downgrades jsonb NOT NULL DEFAULT '[]'::jsonb,
  clusters_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  weight_for double precision NOT NULL,
  weight_against double precision NOT NULL,
  inputs_snapshot jsonb NOT NULL,
  by text NOT NULL
);
CREATE INDEX kb_verdicts_question_idx ON public.kb_verdicts (question_id, id DESC);

-- Which repo knowledge file (data/knowledge/*.jsonl) was loaded when: one row per file hash.
CREATE TABLE public.kb_loads (
  id bigserial PRIMARY KEY,
  file_name text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  loaded_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text CHECK (error IS NULL OR char_length(error) <= 1000)
);
-- A file is loaded once per sha256 when it succeeded; a failed load may be retried (the same bytes fail the same way until the line is fixed in a new file).
CREATE UNIQUE INDEX kb_loads_ok_idx ON public.kb_loads (sha256) WHERE ok;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kb_authors', 'kb_sources', 'kb_questions', 'kb_claims', 'kb_evidence', 'kb_source_links', 'kb_verdicts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Down Migration
DROP TABLE public.kb_loads, public.kb_verdicts, public.kb_source_links, public.kb_evidence, public.kb_claims, public.kb_questions, public.kb_sources, public.kb_authors, public.kb_settings;
