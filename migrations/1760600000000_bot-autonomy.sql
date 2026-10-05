-- Up Migration
-- Bot autonomy (Dvir, 5 Oct 2026): an upload confirmation no longer needs Dvir's words.
ALTER TABLE export_uploads ALTER COLUMN approval_text DROP NOT NULL;
ALTER TABLE export_uploads DROP CONSTRAINT export_uploads_approval_text_check;
ALTER TABLE export_uploads ADD CONSTRAINT export_uploads_approval_text_check CHECK (approval_text IS NULL OR length(trim(approval_text)) > 0);
ALTER TABLE export_uploads ADD COLUMN note text CHECK (note IS NULL OR position('@' in note) = 0);

-- Down Migration
-- Forward-only data case: with rows that have a null approval_text, re-adding NOT NULL fails (export_uploads is append-only).
ALTER TABLE export_uploads DROP COLUMN note;
ALTER TABLE export_uploads DROP CONSTRAINT export_uploads_approval_text_check;
ALTER TABLE export_uploads ADD CONSTRAINT export_uploads_approval_text_check CHECK (length(trim(approval_text)) > 0);
ALTER TABLE export_uploads ALTER COLUMN approval_text SET NOT NULL;
