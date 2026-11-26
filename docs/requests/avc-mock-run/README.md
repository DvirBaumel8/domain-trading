Mock run of the paid AVC pipeline, 26 Nov 2026. Files:
- BUGS.md                 bug list (issue text for DOM/Claude)
- run_mock.py, fake_apis.py   harness (local server + signed webhook + real CLI + fake vendor APIs)
- run_failures.py, failure-cases.json   failure/edge cases (engine down, unpaid order, cap, hostile name ...)
- summary.json, run.log   mock run results
- orders/ORD-261126-a9526b  Austin dentist (Magnolia Family Dentistry): report.html, report.txt, answers.json, order-log.json
- orders/ORD-261126-b14418  Columbus plumber (DrainMaster)
- orders/ORD-261126-04555b  "Tel Aviv, IL" dentist (edge case, shows bug 2)
- failcases/              reports from the failure cases
- free-run/               REAL free-model run (Pollinations, no key): Austin dentist + Columbus plumber, 8 answers each
