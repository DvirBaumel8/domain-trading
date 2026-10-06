-- Up Migration

-- CAP-21a name registry (CR-002 v10.1: "every labelled name is recorded once as fit, dev or test"). One row per domain, never changed:
-- a re-upload with a different value is a conflict, not an overwrite. Not mergeable into another table: it holds names that were
-- never screened or bought. `features` is the recorded feature row (share, history, alt-TLD count, form counts, dated inputs, gate results).
CREATE TABLE labelled_names (
  domain       text PRIMARY KEY CHECK (domain = lower(domain)),
  role         text NOT NULL CHECK (role IN ('fit', 'dev', 'test')),
  label        text NOT NULL CHECK (label IN ('sold', 'dropped')),
  source       text NOT NULL,
  slice        text NOT NULL,
  report_lane  text CHECK (report_lane IN ('expired', 'fresh', 'aged', 'geo')),
  price_cents  integer CHECK (price_cents > 0),
  as_of        date,
  features     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  audit_id     text
);

-- Every replay that was run, with its full report. The hold-clearing check reads the latest holdout-mode row per suite and settings
-- version. Not mergeable: replays belong to neither a settings version (many per version) nor a screening run (no screening happens).
CREATE TABLE replay_runs (
  id              text PRIMARY KEY CHECK (id ~ '^rpl_[0-9a-f]{12}$'),
  suite           text NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('diagnostic', 'holdout')),
  settings_id     integer NOT NULL REFERENCES selection_settings (id),
  settings_label  text NOT NULL,
  filter          jsonb NOT NULL,
  report          jsonb NOT NULL,
  leakage_rows    integer NOT NULL,
  pass            boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  audit_id        text,
  CHECK (mode = 'holdout' OR pass = false)
);
CREATE INDEX replay_runs_suite ON replay_runs (suite, settings_id, created_at DESC);

CREATE TRIGGER labelled_names_append_only BEFORE UPDATE OR DELETE ON labelled_names FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER labelled_names_no_truncate BEFORE TRUNCATE ON labelled_names FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER replay_runs_append_only BEFORE UPDATE OR DELETE ON replay_runs FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER replay_runs_no_truncate BEFORE TRUNCATE ON replay_runs FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Down Migration

DROP TABLE replay_runs;
DROP TABLE labelled_names;
