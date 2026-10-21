# Pick-proof daily seals (CR-073 / CR-073a)
One line per day, committed to main before 19:00 IDT. Append only; never edit past lines.

Format:
`YYYY-MM-DD | plan=<sha256> | pool=<sha256> | seed=<int> | k1=<sha256> | arm:<name>=<picks_sha256>,<scorer_sha256>,wc_unknown=<n>/<k> ; ... | audit=<audit_id> | by=<bot>`

## Seals
2026-10-21 | plan=a0d62702db09dbbf09762c89be988e7f669b0f1afb01c177e674d658f20f1c93 | pool=80ccb7898b4d753fef8efdb5f0716ac96313d2c7d0891b3f8bc5bb8663a98e8d | seed=2160899977 | k1=a0e86235bd84b28cb2f603393169195f70105ace106cc0493071a9851ac9f6f0 | arm:A=d4b85c19ca627e1da8286df0ce1124ecef01a86a16fd99bd975816de4b579d61,4ac02ee31c8806d7f5a90dbb153ba53361ea48efc642e388a62cde5830a6031c,wc_unknown=75/100 ; arm:A-v12fix=0a5bbea5c07afffa8c9e5d8b7e30a2ce56ba787fec71c1dbc462acb40ce2f5ef,5fbc4f8da616241426b84682a0abfce5e5d46516c965355aa1718156430d8f86,wc_unknown=0/100 (imputed 100/100) ; arm:B1=e9bccb1f5b0fbf10ea8f70f4a763557a426bd3e4e6a898b2a105e7a613bdabf8,draw=1feb96d19b61268b946d4bf193fb847810577ebf9172b064dab903c76816281e,wc_unknown=n/a ; arm:B2=4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945,draw=1feb96d19b61268b946d4bf193fb847810577ebf9172b064dab903c76816281e,n=0 VOID (CR-073a) ; arm:C1=decffd4bdcc6f7edb7cfab708ea1b915d58f3d584206ba45c1565209d268a3cb,draw=1feb96d19b61268b946d4bf193fb847810577ebf9172b064dab903c76816281e,wc_unknown=n/a ; arm:C2=not_built | audit=aud_109426e85547adb6ec2daceff4205182 | by=Gavriel (DOM sealed_at 2026-10-21T19:09:52+03:00, data_date 2026-10-20, pool_n 129996; A-v12fix files commit a089b2c)
