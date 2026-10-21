# Pick-proof daily seals (CR-073 / CR-073a)
One line per day, committed to main before 19:00 IDT. Append only; never edit past lines.

Format:
`YYYY-MM-DD | plan=<sha256> | pool=<sha256> | seed=<int> | k1=<sha256> | arm:<name>=<picks_sha256>,<scorer_sha256>,wc_unknown=<n>/<k> ; ... | audit=<audit_id> | by=<bot>`

## Seals
