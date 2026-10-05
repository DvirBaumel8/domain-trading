-- Up Migration
-- Exports are always the full current file. Pending / manual-delist are computed from domains.listing_changed_at against
-- the snapshot time (export_runs.at) of the venue's newest confirmed upload, so the per-file domain record and the
-- stored delist list are gone.
DROP TABLE export_run_domains;
ALTER TABLE export_runs DROP COLUMN changed_only, DROP COLUMN delist;

-- Down Migration
ALTER TABLE export_runs ADD COLUMN delist text[] NOT NULL DEFAULT '{}', ADD COLUMN changed_only boolean NOT NULL DEFAULT false;
CREATE TABLE export_run_domains (
  export_id          text NOT NULL REFERENCES export_runs (export_id),
  domain             text NOT NULL,
  listing_changed_at timestamptz,
  PRIMARY KEY (export_id, domain)
);
CREATE TRIGGER export_run_domains_append_only BEFORE UPDATE OR DELETE ON export_run_domains FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER export_run_domains_no_truncate BEFORE TRUNCATE ON export_run_domains FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
