-- Up Migration

-- A closed tranche is read-only in the database too. main_lane is never NULL: a name whose main-lane standing cannot be told
-- (S7 with an unknown source lane) is not main-lane (controller ruling, 6 Oct 2026).
UPDATE tranche_members SET main_lane = false WHERE main_lane IS NULL;
ALTER TABLE tranche_members ALTER COLUMN main_lane SET NOT NULL;

CREATE FUNCTION tranches_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'tranche % is closed and read-only', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tranches_closed_read_only BEFORE UPDATE ON tranches FOR EACH ROW EXECUTE FUNCTION tranches_guard_update();

CREATE FUNCTION tranche_members_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM tranches WHERE id = OLD.tranche_id) = 'closed' THEN
    RAISE EXCEPTION 'tranche % is closed and read-only', OLD.tranche_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- On an open tranche a member can only be removed (removed_at / removed_by set once, from NULL); nothing else changes.
  IF OLD.removed_at IS NOT NULL
     OR (to_jsonb(NEW) - 'removed_at' - 'removed_by') IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at' - 'removed_by') THEN
    RAISE EXCEPTION 'tranche member % can only be removed, once', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tranche_members_read_only BEFORE UPDATE ON tranche_members FOR EACH ROW EXECUTE FUNCTION tranche_members_guard_update();

-- Down Migration

DROP TRIGGER tranche_members_read_only ON tranche_members;
DROP FUNCTION tranche_members_guard_update();
DROP TRIGGER tranches_closed_read_only ON tranches;
DROP FUNCTION tranches_guard_update();
ALTER TABLE tranche_members ALTER COLUMN main_lane DROP NOT NULL;
