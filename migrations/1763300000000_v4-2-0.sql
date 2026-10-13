-- Up Migration
-- v4.2.0 (CR-044 item 3): the monthly Keyword Planner upload. One upload row and its keyword rows; both append-only. The newest row of a keyword is its demand.
-- Only keyword text and the numbers of the export are stored: no personal data.
CREATE TABLE public.keyword_demand_uploads (
  id bigserial PRIMARY KEY,
  uploaded_at timestamptz NOT NULL,
  title_line text,
  date_range_line text,
  location text,
  month text CHECK (month IS NULL OR month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  rows_n integer NOT NULL CHECK (rows_n >= 0),
  skipped_n integer NOT NULL DEFAULT 0 CHECK (skipped_n >= 0),
  recorded_by text NOT NULL,
  audit_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.keyword_demand (
  id bigserial PRIMARY KEY,
  upload_id bigint NOT NULL REFERENCES public.keyword_demand_uploads (id),
  keyword text NOT NULL CHECK (keyword = lower(keyword) AND keyword <> ''),
  avg_monthly_searches double precision CHECK (avg_monthly_searches IS NULL OR avg_monthly_searches >= 0),
  competition_index integer CHECK (competition_index IS NULL OR competition_index BETWEEN 0 AND 100),
  three_month_change text,
  yoy_change text,
  UNIQUE (upload_id, keyword)
);
CREATE INDEX keyword_demand_keyword_idx ON public.keyword_demand (keyword, upload_id DESC);
CREATE TRIGGER keyword_demand_uploads_append_only BEFORE DELETE OR UPDATE ON public.keyword_demand_uploads FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER keyword_demand_uploads_no_truncate BEFORE TRUNCATE ON public.keyword_demand_uploads FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER keyword_demand_append_only BEFORE DELETE OR UPDATE ON public.keyword_demand FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER keyword_demand_no_truncate BEFORE TRUNCATE ON public.keyword_demand FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- Down Migration
DROP TABLE public.keyword_demand;
DROP TABLE public.keyword_demand_uploads;
