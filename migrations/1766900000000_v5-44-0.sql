-- Up Migration
-- v5.44.0: the after-auction transfer check of an S8 name. transfer_confirmed = true when RDAP names the registrar we imported the name into, false when it names another
-- one, NULL when RDAP could not be read (or the name is not S8: Line 1 names are registered by us). The import sets it; the daily portfolioCheck step re-checks an S8 name
-- until it is true. /report raises S8_TRANSFER_UNCONFIRMED (warn) for an S8 name whose transfer_confirmed is not true.
ALTER TABLE public.domains ADD COLUMN transfer_confirmed boolean;
ALTER TABLE public.domains ADD COLUMN transfer_checked_at timestamptz;

-- Down Migration
ALTER TABLE public.domains DROP COLUMN transfer_checked_at;
ALTER TABLE public.domains DROP COLUMN transfer_confirmed;
