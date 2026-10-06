-- Up Migration

-- Tranches (CAP-04, ruling R6): a batch of names screened and approved together. One tranche is open at a time; a closed tranche is
-- read-only (enforced in the service) and keeps its close report. Not mergeable into another table: members change over time
-- (add / remove) and a tranche has its own lifecycle. Counts and quotas use the selection settings active at the time of the call.
CREATE TABLE tranches (
  id               text PRIMARY KEY CHECK (id ~ '^trn_[0-9a-f]{12}$'),
  name             text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  opened_by        text NOT NULL,
  closed_at        timestamptz,
  closed_by        text,
  settings_label   text NOT NULL,
  spend_cap_cents  integer CHECK (spend_cap_cents > 0),
  close_report     jsonb,
  audit_id         text,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_tranche ON tranches ((true)) WHERE status = 'open';

-- main_lane is NULL when it cannot be told (an S7 name whose source lane is unknown while the history source is off).
CREATE TABLE tranche_members (
  id              bigserial PRIMARY KEY,
  tranche_id      text NOT NULL REFERENCES tranches (id),
  domain          text NOT NULL CHECK (domain = lower(domain)),
  lane            text NOT NULL,
  is_geo          boolean NOT NULL,
  main_lane       boolean,
  est_cost_cents  integer CHECK (est_cost_cents > 0),
  run_id          text NOT NULL REFERENCES screening_runs (id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  added_by        text NOT NULL,
  removed_at      timestamptz,
  removed_by      text
);
CREATE UNIQUE INDEX tranche_members_active ON tranche_members (tranche_id, domain) WHERE removed_at IS NULL;

CREATE TRIGGER tranches_no_delete BEFORE DELETE ON tranches FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER tranche_members_no_delete BEFORE DELETE ON tranche_members FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Down Migration

DROP TABLE tranche_members;
DROP TABLE tranches;
