-- Up Migration
-- v5.18.0 (CR-068): the $0 visitor counter. Token scope `visits` (may call only POST /visits/hit), the daily aggregate table, and the on/off setting.
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data', 'visits'));
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data', 'visits', 'admin', 'job'));

-- settings.visits_enabled (`visits.enabled`): off until Dvir's line names "visits"; changed only by POST /visits/settings (WRITE + approval_ref).
ALTER TABLE public.settings ADD COLUMN visits_enabled boolean NOT NULL DEFAULT false;
-- settings.visits_token_request (`visits.token_request`): POST /visits/settings {token: "request"} sets 'requested'; the host's `admin visits-token-handoff` issues the token and marks 'issued'.
ALTER TABLE public.settings ADD COLUMN visits_token_request text CONSTRAINT settings_visits_token_request_check CHECK (visits_token_request IN ('requested', 'issued'));
ALTER TABLE public.settings ADD COLUMN visits_token_requested_at timestamp with time zone;
ALTER TABLE public.settings ADD COLUMN visits_token_issued_at timestamp with time zone;

-- One row per domain, UTC day and source; counts only (no IP, cookie, path or user agent is ever stored). Kept 400 days (retention job).
-- source dom_redirect = our Worker's redirect hits; source afternic = Afternic's own 30-day Views/Leads read (POST /visits/import).
CREATE TABLE public.visit_daily (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain text NOT NULL,
    date_utc date NOT NULL,
    source text NOT NULL CHECK (source IN ('dom_redirect', 'afternic')),
    human_hits integer NOT NULL DEFAULT 0 CHECK (human_hits >= 0),
    bot_hits integer NOT NULL DEFAULT 0 CHECK (bot_hits >= 0),
    capped integer NOT NULL DEFAULT 0 CHECK (capped >= 0),
    referrer_hosts jsonb NOT NULL DEFAULT '{}'::jsonb,
    views_30d integer CHECK (views_30d IS NULL OR views_30d >= 0),
    leads_30d integer CHECK (leads_30d IS NULL OR leads_30d >= 0),
    imported_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT visit_daily_key UNIQUE (domain, date_utc, source)
);
CREATE INDEX visit_daily_date ON public.visit_daily (date_utc);

-- One row per domain: where POST /visits/forward/{domain} last pointed the registrar URL forward. Active = reverted_at IS NULL (the counting redirect is on).
CREATE TABLE public.visit_forwards (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain text NOT NULL UNIQUE,
    target text NOT NULL,
    before_forwards jsonb NOT NULL DEFAULT '[]'::jsonb,
    set_at timestamp with time zone NOT NULL,
    reverted_at timestamp with time zone
);

-- Down Migration
DROP TABLE public.visit_forwards;
DROP TABLE public.visit_daily;
ALTER TABLE public.settings DROP COLUMN visits_token_issued_at;
ALTER TABLE public.settings DROP COLUMN visits_token_requested_at;
ALTER TABLE public.settings DROP COLUMN visits_token_request;
ALTER TABLE public.settings DROP COLUMN visits_enabled;
DELETE FROM public.api_tokens WHERE scope = 'visits';
ALTER TABLE public.api_tokens DROP CONSTRAINT api_tokens_scope_check;
ALTER TABLE public.api_tokens ADD CONSTRAINT api_tokens_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data'));
ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'intake', 'data', 'admin', 'job'));
