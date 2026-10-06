# Sibling census lists (frozen)

**Purpose:** DEMAND-1 / `/census/siblings` / `/census/run` (selection v9.1 C19; DR-002 V9-03, V9-04).

## Status
Lists are **to be frozen by the backend build**. Until then this folder holds only this README. Bots and agents must **not** invent or commit sibling lists ad hoc (`SEL8-1`, `SEL9-11`).

## Expected layout (when frozen)
- One CSV per pattern: `system/census/<pattern_id>.csv`
- About **20 stems** per pattern, **both word orders** where natural
- Versioned: cards and API responses show `pattern_id@version`
- `/census/run` **refuses** bot-supplied sibling lists; it only runs against these files

## Definition of `in_use`
A sibling counts as **in use** only if all of the following hold:
1. HTTP **200** on the final response
2. Final host **is the sibling** (no redirect off-domain)
3. Page does **not** match the backend parking / for-sale list
4. **≥200 characters** of visible text

Also log (features, not the DEMAND-1 gate alone):
- `registered_share`
- `forsale_share`

Shadow-book note (DR-002 V9-04): test `registered_share ≥ 0.6` as an alternative bar before changing the gate.
