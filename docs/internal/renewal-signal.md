# Renewal signal (v5.65.0, F44)
Advice for Dvir's renew-or-drop decision. **Nothing renews, drops or changes a plan** (founder rule 3: Dvir decides every renewal). Code `src/modules/reporting/report/renewal-signal.ts`; shown in `GET /report` `per_domain[].renewal_signal` (and `GET /portfolio`) for `owned`, `listed`, `delisted` names.

Inputs: the newest `visit_daily` row of source `afternic` per name (`views_30d`, `leads_30d`; the daily `afternicSync` stores them from the free Afternic stats API) and the newest row at least 30 days older (the trend); offers received in the last 365 days (`offers`, any outcome); days to `expiry_date` (IDT); `settings.renew_views_min` (default 10, migration only).

Rules, in this order:
1. `too_early`: more than 90 days to expiry (or no expiry date).
2. `renew`: `leads_30d >= 1`, or an offer in the last 365 days, or `views_30d >= renew_views_min`.
3. no Afternic read of the name yet: `signal` null (nothing to judge by).
4. `reprice`: `views_30d >= 1` below the minimum (no lead, no offer).
5. `drop`: `views_30d = 0`, no lead, no offer.

`RENEWAL_SIGNAL_DROP` (info) is raised for a `drop` within 60 days of expiry. `renewal_available` is false when the one renewal is used. Limits: the signal uses only Afternic traffic (not Sedo or the redirect counter) and a stale latest row is used as it is. Tests RS44-1..4 (`tests/modules/reporting/renewal-signal.test.ts`).
