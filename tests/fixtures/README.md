# Test fixtures

- `porkbun-openapi-v3.53.json` (+ `.sha256`): Porkbun OpenAPI 3.0 spec, version 3.53, fetched on 2026-10-05 from https://porkbun.com/api/json/v3/spec. Pinned for the offline contract tests (`tests/unit/porkbun-contract.test.ts`). Refresh with `npm run contract:refresh-spec` (prints a diff; never overwrites).
