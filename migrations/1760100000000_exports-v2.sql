-- Up Migration
ALTER TABLE export_runs ADD COLUMN export_id text, ADD COLUMN changed_only boolean NOT NULL DEFAULT false;
UPDATE export_runs SET export_id = 'exp_legacy_' || id WHERE export_id IS NULL;
ALTER TABLE export_runs ALTER COLUMN export_id SET NOT NULL, ADD CONSTRAINT export_runs_export_id_key UNIQUE (export_id);

CREATE TABLE export_uploads (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue         text NOT NULL CHECK (venue IN ('afternic', 'sedo')),
  export_id     text NOT NULL UNIQUE REFERENCES export_runs (export_id),
  domains       text[] NOT NULL,
  uploaded_at   timestamptz NOT NULL,
  approval_text text NOT NULL CHECK (length(trim(approval_text)) > 0),
  audit_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX export_uploads_venue_at ON export_uploads (venue, uploaded_at);
CREATE TRIGGER export_uploads_append_only BEFORE UPDATE OR DELETE ON export_uploads FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER export_uploads_no_truncate BEFORE TRUNCATE ON export_uploads FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

ALTER TABLE domains ADD COLUMN listing_changed_at timestamptz;
UPDATE domains SET listing_changed_at = updated_at WHERE status = 'listed';

ALTER TABLE audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'admin', 'job'));

ALTER TABLE settings ALTER COLUMN sedo_hybrid_as SET DEFAULT 'make_offer';
UPDATE settings SET sedo_hybrid_as = 'make_offer', updated_at = now();

-- Down Migration
-- Forward-only data case: if audit_log rows with scope 'job' exist, re-adding the old scope CHECK fails (rows are append-only and cannot be removed); same as 4b-1's 'delisted'.
UPDATE settings SET sedo_hybrid_as = 'buy_now', updated_at = now();
ALTER TABLE settings ALTER COLUMN sedo_hybrid_as SET DEFAULT 'buy_now';
ALTER TABLE audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'admin'));
ALTER TABLE domains DROP COLUMN listing_changed_at;
DROP TABLE export_uploads;
ALTER TABLE export_runs DROP CONSTRAINT export_runs_export_id_key, DROP COLUMN changed_only, DROP COLUMN export_id;
