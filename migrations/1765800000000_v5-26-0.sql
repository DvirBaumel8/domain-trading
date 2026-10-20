-- Up Migration
-- v5.26.0 (CR-072): the closeout candidates are filtered and scored once in the datasave job (step scorePool) and stored with the rows.
-- filter_code = the first hard filter the name failed (null = passed); scored_at = the row was processed; model_version = the engine model that scored it.
-- datasave_pool already has score / score_reason (v5.21.0); dynadot_rows gets them now.
ALTER TABLE public.datasave_pool ADD COLUMN filter_code text;
ALTER TABLE public.datasave_pool ADD COLUMN scored_at timestamptz;
ALTER TABLE public.datasave_pool ADD COLUMN model_version text;
ALTER TABLE public.dynadot_rows ADD COLUMN score numeric;
ALTER TABLE public.dynadot_rows ADD COLUMN score_reason text;
ALTER TABLE public.dynadot_rows ADD COLUMN filter_code text;
ALTER TABLE public.dynadot_rows ADD COLUMN scored_at timestamptz;
ALTER TABLE public.dynadot_rows ADD COLUMN model_version text;
-- R-2 DIGITS_OR_HYPHEN: on = a name with a digit or a hyphen is filtered (a setting, default on).
ALTER TABLE public.settings ADD COLUMN closeouts_filter_digits_hyphen boolean NOT NULL DEFAULT true;

-- Down Migration
ALTER TABLE public.settings DROP COLUMN closeouts_filter_digits_hyphen;
ALTER TABLE public.dynadot_rows DROP COLUMN model_version;
ALTER TABLE public.dynadot_rows DROP COLUMN scored_at;
ALTER TABLE public.dynadot_rows DROP COLUMN filter_code;
ALTER TABLE public.dynadot_rows DROP COLUMN score_reason;
ALTER TABLE public.dynadot_rows DROP COLUMN score;
ALTER TABLE public.datasave_pool DROP COLUMN model_version;
ALTER TABLE public.datasave_pool DROP COLUMN scored_at;
ALTER TABLE public.datasave_pool DROP COLUMN filter_code;
