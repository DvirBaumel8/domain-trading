-- Up Migration
-- v5.10.0 (CR-061): token scope `data` (non-money uploads: POST /candidates/intake, /engine/sales, /engine/unsold, /data/*), and the holdout guard date.
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data'));
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data', 'admin', 'job'));

-- engine.sales_max_date: sales and unsold rows dated after it are rejected (HOLDOUT_SEALED). Changed only by POST /engine/holdout-date (WRITE + Dvir's approval_ref).
ALTER TABLE public.settings ADD COLUMN engine_sales_max_date date NOT NULL DEFAULT DATE '2026-10-14';

-- Down Migration
ALTER TABLE public.settings DROP COLUMN engine_sales_max_date;
DELETE FROM public.api_tokens WHERE scope = 'data';
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write', 'intake'));
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'intake', 'admin', 'job'));
