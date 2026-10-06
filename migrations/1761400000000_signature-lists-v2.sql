-- Up Migration

-- Signature lists v2 for the history check (CAP-07, HIST-2; CR-002 §5 P-6 and Amendment A1). DOM's starter additions, kept small and
-- conservative; Gavriel maintains the lists afterwards through POST /selection/lists/{name} (versioned, audited).
--   * new classes in sig_harmful_*: `pbn` (PBN / link-farm spam) and `trademark` (trademark abuse), so every HIST-2 fail class
--     (blocklist listing, malware/phishing, spam, adult, scam, trademark abuse) has terms to match;
--   * sig_parked / sig_forsale: parking and for-sale marketplace HOSTS, matched against the target of an off-site redirect, so a capture
--     that redirects to a parking page or a for-sale lander is parked / for-sale history (positive, PASS), not a FLAG for an off-site redirect.
-- Each list gets version max+1 holding the newest terms plus the additions (a list Gavriel already changed keeps its terms).
CREATE FUNCTION seed_signature_lists_v2() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  r record;
  cur text[];
  nxt integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('sig_harmful_strong', ARRAY['pbn:buy backlinks', 'pbn:paid guest posts', 'pbn:private blog network', 'trademark:counterfeit handbags', 'trademark:fake rolex', 'trademark:replica watches']::text[]),
    ('sig_harmful_weak', ARRAY['pbn:guest post', 'pbn:sponsored post', 'pbn:write for us', 'trademark:knockoff', 'trademark:replica']::text[]),
    ('sig_parked', ARRAY['parked:above.com', 'parked:alldomains.com', 'parked:bodis.com', 'parked:default web site page', 'parked:parkingcrew.net', 'parked:sedoparking.com']::text[]),
    ('sig_forsale', ARRAY['forsale:afternic.com', 'forsale:atom.com', 'forsale:brandbucket.com', 'forsale:buydomains.com', 'forsale:dan.com', 'forsale:hugedomains.com', 'forsale:sedo.com', 'forsale:squadhelp.com', 'forsale:this domain name is for sale', 'forsale:undeveloped.com']::text[])
  ) AS v(name, extra) LOOP
    SELECT terms, version INTO cur, nxt FROM selection_lists WHERE name = r.name ORDER BY version DESC LIMIT 1;
    INSERT INTO selection_lists (name, version, terms, created_by, note)
    VALUES (r.name, COALESCE(nxt, 0) + 1,
      ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(cur, ARRAY[]::text[]) || r.extra) AS t ORDER BY t),
      'migration', 'v2 starter additions (DOM): pbn and trademark classes; parking and for-sale marketplace hosts for redirect targets');
  END LOOP;
END
$fn$;

SELECT seed_signature_lists_v2();

-- Down Migration

ALTER TABLE selection_lists DISABLE TRIGGER selection_lists_append_only;
DELETE FROM selection_lists WHERE created_by = 'migration' AND note LIKE 'v2 starter additions (DOM)%';
ALTER TABLE selection_lists ENABLE TRIGGER selection_lists_append_only;
DROP FUNCTION seed_signature_lists_v2();
