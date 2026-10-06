-- Up Migration

-- Two caches for the screening checks (CR-001 CAP-03, CAP-10, CAP-12). Neither is a record: both are re-fetchable and pruned
-- (rdap_lookups after 30 days, reference_files beyond the last 10 per name), so they carry no append-only trigger.
-- They are not in the backup export for the same reason.

-- One RDAP answer per lookup. `unknown` rows are kept for diagnosis but are never reused as an answer.
CREATE TABLE rdap_lookups (
  id           bigserial PRIMARY KEY,
  domain       text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('registered', 'not_registered', 'unknown')),
  reason_code  text,
  http_status  integer,
  facts        jsonb,
  evidence_id  bigint REFERENCES screening_evidence (id),
  checked_at   timestamptz NOT NULL
);
CREATE INDEX rdap_lookups_domain ON rdap_lookups (domain, checked_at DESC);

-- A downloaded reference file (the IANA RDAP bootstrap here; Tranco and NameBio in a later task). `same_as_id` points at the
-- row holding the identical body, so an unchanged daily download stores no second copy.
CREATE TABLE reference_files (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  source_url  text NOT NULL,
  fetched_at  timestamptz NOT NULL,
  data_date   date,
  sha256      char(64) NOT NULL,
  bytes       integer NOT NULL,
  body_gz     bytea,
  same_as_id  bigint REFERENCES reference_files (id)
);
CREATE INDEX reference_files_name ON reference_files (name, fetched_at DESC);

-- Down Migration
DROP TABLE reference_files;
DROP TABLE rdap_lookups;
