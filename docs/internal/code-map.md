# Code map

About 850 lines. The app keeps nothing: it reads `data/state.json` at start and asks Porkbun and the .com registry on demand.

| File | Inside |
|---|---|
| `data/state.json` | **The whole state**: domains owned and the money ledger. No private price or approval text |
| `data/access.json` | Who may read: name -> sha256 of the token |
| `src/state.ts` | Its schema and rules (`problems`), what may never change (`rewrites`), the caps `MAX_DOMAINS`, `MAX_PURCHASE_CENTS`, `MAX_SPENT_CENTS` |
| `scripts/check-state.ts` | `npm run check-state`, run by CI: the rules, no future date, approval records exist, and the append-only check over git history |
| `src/app.ts`, `src/main.ts`, `src/config.ts` | The app (`/health/ping`, `/health`), the start, the environment |
| `src/books.ts` | `GET /portfolio`, `/portfolio/:domain`, `/ledger`, `/report` |
| `src/registrars/api.ts`, `check.ts` | `GET /check`: quotes, 60 s cache |
| `src/registrars/porkbun.ts` | The Porkbun price lookup (nothing that buys) |
| `src/registrars/selection.ts`, `registry.ts`, `types.ts` | Which quote wins, the allowed registrars, types |
| `src/http/auth.ts`, `errors.ts` | Tokens, limits, the error shape |
| `src/core/` | `money.ts`, `dates.ts`, `rdap.ts`; `src/domain-name.ts` is beside it |
| `scripts/release.ts` | `npm run release -- X.Y.Z "summary"` |

Tests: `tests/app.test.ts` (every route), `tests/unit/` (state, config, money, rdap, domain names, stateless guard, no AI, no top-up, removed providers), `tests/registrars/`, `tests/contract/version-sync.test.ts`.

| To change | Go to |
|---|---|
| Record a purchase, cost, renewal or sale | `data/state.json` (docs/DEPLOYMENT.md "Record a change") |
| A cap | `src/state.ts` |
| A route | `src/books.ts` or `src/app.ts`, then `docs/contract/endpoints.md` |
| Who may read | `data/access.json` |
| The pricing rules (by hand) | `docs/internal/pricing.md` |
| Open items | `docs/internal/gaps.md` |
