# Deploys

One line per push to main that changed code, written by the deploy-live workflow (CR-034): `<time IDT> deploy_live|deploy_failed <version> <commit>`.

2026-10-09T16:09:01+0300 deploy_failed 3.6.0 9558d525c3c19cc1f9969d683ddb3802561ffa1e
2026-10-09T16:14:08+0300 deploy_live 3.7.0 83fe40acad3cac0d141849d07b439e0a1031dbd2
2026-10-09T16:26:12+0300 deploy_live 3.7.0 e5f997d278eb21ee1bec5b6d3313a0a1aa090bbe

**Moved (2026-10-09 16:45 IDT):** new lines go to `DEPLOYS.md` on the branch **`deploy-log`** (`git show origin/deploy-log:DEPLOYS.md`), never to main, so a note can't race with a code push again (CR-034, the 16:35 note). The `deploy-note` check on main is unchanged.
