# CR-131: apify push fails on actor version format (from Gavriel, 26 Nov 2026)

Symptom: workflow apify-push, job push-private, failed on main (run 45809519250, commit 62f97c07). Log: "Error: Version number must be MAJOR.MINOR, where MAJOR and MINOR is a number in range from 0 to 99."
Evidence: .actor/actor.json of wayback-domain-history, broken-link-auditor, bulk-pagespeed-checker all have "version": "0.1.0".
Ask: change to "0.1" in the three actors (and any other actor pushed), add a test that actor.json version matches ^\d{1,2}\.\d{1,2}$, then re-run apify-push. Private push only; no publish.
