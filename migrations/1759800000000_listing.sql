-- Up Migration

CREATE TABLE export_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  marketplace  text NOT NULL CHECK (marketplace IN ('afternic', 'sedo')),
  at           timestamptz NOT NULL DEFAULT now(),
  domains      text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX export_runs_marketplace_at ON export_runs (marketplace, at);
ALTER TABLE domains ADD COLUMN delisted_at timestamptz;

-- Down Migration

ALTER TABLE domains DROP COLUMN delisted_at;
DROP TABLE export_runs;
