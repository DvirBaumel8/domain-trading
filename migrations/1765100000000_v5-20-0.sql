-- Up Migration
-- v5.20.0 (CR-069): token scope `bots` (the shared non-money token for all bots). Extends the api_tokens and audit_log scope CHECKs.
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data', 'visits', 'bots'));
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data', 'visits', 'bots', 'admin', 'job'));
-- CR-069 item 6: the optional X-Bot-Name header of a call (logged, not a security check).
ALTER TABLE public.audit_log ADD COLUMN bot_name text;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_bot_name_len CHECK (bot_name IS NULL OR char_length(bot_name) <= 40);

-- BUG-047: where a recorded renewal price came from (POST /portfolio/{domain}/renewal-price).
ALTER TABLE public.domains ADD COLUMN renewal_price_source text;
ALTER TABLE public.domains ADD COLUMN renewal_price_as_of date;

-- BUG-046: the visit_daily rows of the UTC day 2026-10-19 are all test hits.
DELETE FROM public.visit_daily WHERE date_utc = DATE '2026-10-19';

-- Down Migration
ALTER TABLE public.domains DROP COLUMN renewal_price_as_of;
ALTER TABLE public.domains DROP COLUMN renewal_price_source;
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_bot_name_len;
ALTER TABLE public.audit_log DROP COLUMN bot_name;
DELETE FROM public.api_tokens WHERE scope = 'bots';
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data', 'visits'));
-- audit_log is append-only: its scope CHECK keeps `bots`, so audit rows written by bots tokens stay valid after a rollback.
