# CR-132: apify_guard.py GET fails after a good push (from Gavriel, 26 Nov 2026)

Symptom: apify-push, job push-private, run 45810256078 (commit 250806c6). The push step worked ("pushed wayback-domain-history", "pushed broken-link-auditor"; 3rd actor see log). Then "Post-push check" failed for all 3 actors: "<name>: GET failed (HTTPError)". So the guard could not confirm private and unpriced.
Hunch (verify): the GET to /v2/acts/me~<name> returns 401/403/404 (token scope, or me~ not resolving), or the actor is not readable right after creation.
Ask: print the HTTP status code (never the token or URL headers) in the error line; fix the lookup (e.g. use the id or username~name, retry a few times with short waits); add a test with a faked HTTPError code. Keep push private only, no publish, no price. Then re-run apify-push.
