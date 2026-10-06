-- Up Migration

-- Persisted screening runs (CR-001 CAP-20), their per-check results, and Dvir-entered renewal quotes (CAP-17 manual).
-- Render free sleeps, so every check's state is in the DB and a run resumes where it stopped.

-- Mutable by design (state, not records): status, heartbeat_at, finished_at, summary.
CREATE TABLE screening_runs (
  id              text PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  audit_id        text,
  mode            text NOT NULL CHECK (mode IN ('live', 'full')),
  backtest        boolean NOT NULL,
  settings_id     integer NOT NULL REFERENCES selection_settings (id),
  settings_label  text NOT NULL,
  buy_hold        boolean NOT NULL,
  tranche_id      text,
  input           jsonb NOT NULL,   -- {names: RunItem[], checks?: CheckId[]}
  gate_plan       jsonb NOT NULL,   -- {<lane>: CheckId[]} snapshot of the plan per lane
  list_versions   jsonb NOT NULL,   -- {<list>: version} of every list a planned check declares
  status          text NOT NULL CHECK (status IN ('running', 'done', 'partial')),
  deadline_at     timestamptz NOT NULL,
  heartbeat_at    timestamptz,
  finished_at     timestamptz,
  summary         jsonb
);
CREATE INDEX screening_runs_running ON screening_runs (status) WHERE status = 'running';

-- One row per (item, check) per run (+ manual records, + cache copies). Append-only: a manual record or a re-run adds a row.
CREATE TABLE screening_results (
  id              bigserial PRIMARY KEY,
  run_id          text NOT NULL REFERENCES screening_runs (id),
  item_idx        smallint NOT NULL,
  domain          text NOT NULL,
  lane            text NOT NULL,
  check_id        text NOT NULL,
  gate            text NOT NULL,
  rule_ids        text[] NOT NULL,
  status          text NOT NULL CHECK (status IN ('PASS', 'PASS_WITH_NOTE', 'FLAG', 'FAIL', 'UNKNOWN', 'MANUAL_REQUIRED', 'NOT_RUN')),
  reason_code     text,
  reason          text,
  fields          jsonb NOT NULL,
  data_as_of      timestamptz,
  checked_at      timestamptz NOT NULL,
  settings_label  text NOT NULL,
  list_versions   jsonb NOT NULL,
  duration_ms     integer NOT NULL,
  upstream_calls  integer NOT NULL,
  evidence_ids    bigint[] NOT NULL DEFAULT '{}',
  source          text NOT NULL CHECK (source IN ('auto', 'cache', 'manual')),
  cached_from     bigint REFERENCES screening_results (id),
  recorded_by     text,
  audit_id        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'PASS' OR reason_code IS NOT NULL)
);
-- A resumed or racing worker cannot write the same (item, check) twice; manual records are exempt (a later one supersedes).
CREATE UNIQUE INDEX screening_results_once ON screening_results (run_id, item_idx, check_id) WHERE source <> 'manual';
CREATE INDEX screening_results_domain_check ON screening_results (domain, check_id, checked_at DESC);
CREATE TRIGGER screening_results_append_only BEFORE UPDATE OR DELETE ON screening_results
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER screening_results_no_truncate BEFORE TRUNCATE ON screening_results
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Dvir-entered renewal quote for a registrar the machine cannot quote (e.g. GoDaddy with fewer than 50 domains).
-- Not the `quotes` table: that one is one adapter comparison (check_id, eligible, raw) read by the reconciler and /portfolio by domain;
-- a human value there would feed the reconciler's renewal lookup and carries no who/why/observed-at.
CREATE TABLE manual_quotes (
  id               bigserial PRIMARY KEY,
  domain           text NOT NULL CHECK (domain = lower(domain)),
  registrar        text NOT NULL,
  renewal_cents    integer NOT NULL CHECK (renewal_cents > 0),
  first_year_cents integer CHECK (first_year_cents > 0),
  source_url       text,
  source_note      text NOT NULL,
  observed_at      timestamptz NOT NULL,
  recorded_by      text NOT NULL,
  audit_id         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manual_quotes_domain ON manual_quotes (domain, observed_at DESC);
CREATE TRIGGER manual_quotes_append_only BEFORE UPDATE OR DELETE ON manual_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER manual_quotes_no_truncate BEFORE TRUNCATE ON manual_quotes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Down Migration

DROP TABLE manual_quotes;
DROP TABLE screening_results;
DROP TABLE screening_runs;
