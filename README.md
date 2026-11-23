# domain-trading

A small, stateless HTTP API for a domain-trading proof of concept: the domains we own, the money we spent, and a price check. No database. Runs on Render's free plan.

- **State:** `data/state.json` (the app only reads it; a change is a commit, checked by CI).
- **API contract:** `docs/contract/`. **Deploy and how to record a purchase:** `docs/DEPLOYMENT.md`. **Code:** `docs/internal/code-map.md`. **DOM's manual:** `CLAUDE.md`.

Run: `npm install && npm run dev` (Node 26). Test: `npm test && npx tsc --noEmit && npm run build && npm run check-state`.
