-- Up Migration
CREATE TABLE export_run_domains (
  export_id          text NOT NULL REFERENCES export_runs (export_id),
  domain             text NOT NULL,
  listing_changed_at timestamptz,
  PRIMARY KEY (export_id, domain)
);
CREATE TRIGGER export_run_domains_append_only BEFORE UPDATE OR DELETE ON export_run_domains FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER export_run_domains_no_truncate BEFORE TRUNCATE ON export_run_domains FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
ALTER TABLE export_runs ADD COLUMN delist text[] NOT NULL DEFAULT '{}';

-- Down Migration
ALTER TABLE export_runs DROP COLUMN delist;
DROP TABLE export_run_domains;
