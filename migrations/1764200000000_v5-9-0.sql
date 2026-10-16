-- Up Migration
-- v5.9.0 (CR-060): the S8 default BIN ladder by name length (Dvir, 14 Oct 2026: $2,488 / $3,488 / $4,888; DOM's length cut-offs, 16 Oct 2026).
-- An array of {max_len, bin_cents}, ascending by max_len; the last entry has max_len null (no upper limit). The length is the number of characters before ".com".
-- It changes only by migration (founder rule 2 spirit; no API). S8 BINs are exempt from the Line 1 price list (CR-060 decision, gaps.md).
ALTER TABLE public.settings ADD COLUMN s8_bin_ladder jsonb NOT NULL
  DEFAULT '[{"max_len":8,"bin_cents":488800},{"max_len":12,"bin_cents":348800},{"max_len":null,"bin_cents":248800}]'::jsonb
  CONSTRAINT settings_s8_bin_ladder_check CHECK (jsonb_typeof(s8_bin_ladder) = 'array' AND jsonb_array_length(s8_bin_ladder) >= 1);

-- Down Migration
ALTER TABLE public.settings DROP COLUMN s8_bin_ladder;
