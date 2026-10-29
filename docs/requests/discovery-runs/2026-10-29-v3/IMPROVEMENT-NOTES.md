# Improvement notes — Buyer · discovery v3 Option 1 · prompt: SOP 04 v3 + §0.0 AI3 · data_date 2026-10-29
1. AI3 prior-exclude worked: 214/562 skipped free before meaning (union of Oct 27/28 kills + prior-exclude + paper-log + holds).
2. Shortlist API param is `date=` (not `data_date=`) — first GET 400'd; fix SOP wording.
3. ~95% of field is $1 single-bid local-biz/person/geo names (attorneys/lawyers by SC county alone ~25). Ask DOM for a cheap geo+trade / person-name tag pre-serve to cut meaning load.
4. Run firm-screen exact-phrase grep on a search snippet BEFORE fetching: homeownerclaims died because market phrasing is "homeowners claim" — singular/plural/possessive check should be free and first.
5. Same-name local firm (snowplowsolutionswi.com) found via one search — do the R-ONE search before USPTO next time.
6. CR-083 POST blocked by DB_SIZE_HIGH (74.2%); DOM needs retention/vacuum or a CR-083 exemption (tiny payloads).
7. Closeouts endpoint has NO_ACTIVE_MODEL → alphabetical tip-200 is not a meaningful D sample; ask DOM for ranked closeouts or offset sampling.
8. Budget: ~24 calls (over 20). Next: cap firm work at 2 names.
