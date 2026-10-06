# Release notes

One file per release: `vX.Y.Z.md`, where `X.Y.Z` is the **contract** version it ships (`docs/contract/CHANGELOG.md`). DOM writes it as part of done. A release isn't done until it is deployed, or the note says exactly what blocks the deploy.

## Template
```markdown
# Release vX.Y.Z (YYYY-MM-DD)

**Contract:** vX.Y.Z (MAJOR | MINOR | PATCH). Requests: CR-### / BUG-###. Commit: <sha>.

## What's in it
Short list of what changed, for Gavriel.

## Contract changes
Routes, fields, codes, behaviours added / changed / removed (the `CHANGELOG.md` entry). Breaking changes first, marked **BREAKING**.

## Impact on Gavriel
What Gavriel must change in his calls or prompts, and by when. "None" if nothing.

## How to test it (through the API, dry_run only)
Step-by-step calls Gavriel can make. Every `POST /buy` and `POST /list` in a test sends `"dry_run": true`; no step spends money. Expected status codes and fields for each.

## Deploy status
Deployed to <URL> at <time> (`GET /health` version <v>) | Pending: <what is missing, who does it>.

## Known issues / gaps
Links to `docs/internal/gaps.md` entries or open BUGs.
```
