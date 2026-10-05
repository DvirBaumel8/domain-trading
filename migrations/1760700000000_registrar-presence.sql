-- Up Migration
CREATE TABLE registrar_presence (
  domain_id        bigint PRIMARY KEY REFERENCES domains (id),
  status           text NOT NULL CHECK (status IN ('present', 'absent')),
  first_absent_at  timestamptz,
  last_checked_at  timestamptz NOT NULL,
  CONSTRAINT registrar_presence_absent_since CHECK ((status = 'absent') = (first_absent_at IS NOT NULL))
);

-- Down Migration
DROP TABLE registrar_presence;
