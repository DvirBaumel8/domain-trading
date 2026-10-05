-- Up Migration
-- drop_date may be expiry + 1 y (default) or the expiry itself (Gate F: drop at first expiry); never later
ALTER TABLE domains DROP CONSTRAINT domains_drop_date_rule;
ALTER TABLE domains ADD CONSTRAINT domains_drop_date_rule CHECK (
  renewals_used = 1 OR drop_date IS NULL OR drop_date = (expiry_date + interval '1 year')::date OR drop_date = expiry_date);

-- Down Migration
-- fails once any row has drop_date = expiry_date (one-way relaxation)
ALTER TABLE domains DROP CONSTRAINT domains_drop_date_rule;
ALTER TABLE domains ADD CONSTRAINT domains_drop_date_rule CHECK (
  renewals_used = 1 OR drop_date IS NULL OR drop_date = (expiry_date + interval '1 year')::date);
