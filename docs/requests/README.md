# Requests to DOM

Gavriel (for Dvir) asks DOM for changes here, one file per request. DOM answers **in the same file** (a `## DOM response` section at the end, plus a one-line status at the top), then builds, releases and links the release note.

- **CR-###** = change request: a new business need. File: `CR-###-<short-name>.md`.
- **BUG-###** = the API didn't do what the contract says. File: `BUG-###-<short-name>.md`.
- Numbers are sequential per kind. Reference material goes in `CR-###-reference/`.
- **Status line** (first line of the file): `Draft` → `Approved by Dvir <date>` → `DOM: accepted | accepted with changes | declined` → `In progress (release vX.Y.Z)` → `Released vX.Y.Z` (link) → `Closed`.
- A CR that spends money, changes a founder rule or a cap, or adds a paid service needs Dvir's approval in the file before DOM builds it. DOM's answer flags every point that needs Dvir as **DVIR**.

## CR template
```markdown
> Status: Draft

# CR-### — <title>
| Field | Value |
|---|---|
| CR id | CR-### |
| From | Gavriel, on behalf of Dvir |
| Date | YYYY-MM-DD HH:MM IDT |
| Approved by Dvir | <date and his words, or "not yet"> |
| Priority | P1 (needed for <what/when>) / P2 (later) |

## 1. Business need
Why this is needed and what goes wrong without it. No implementation.

## 2. Rules
The business rules the system must follow, numbered (R-1, R-2, …). Thresholds as values, or as settings with a default.

## 3. Acceptance criteria
Pass/fail checks DOM tests against, numbered (AC-1, …): input → expected result, via the API.

## 4. Open questions for DOM
Numbered (Q1, …).

<!-- DOM writes below this line -->
## DOM response (YYYY-MM-DD)
Verdict, pushback, answers to the questions, release plan (contract version), decisions needed from Dvir (DVIR).
```

## BUG template
```markdown
> Status: Open

# BUG-### — <title>
| Field | Value |
|---|---|
| BUG id | BUG-### |
| From | Gavriel |
| Date | YYYY-MM-DD HH:MM IDT |
| Contract version | vX.Y.Z (from the release note) |
| Severity | money-impacting / blocks work / wrong data / cosmetic |

## Call made
Method, path, the request body (no tokens or secrets), the `Idempotency-Key`, and the time.

## Expected
What the contract says should happen (cite `docs/contract/<file>` and the section).

## Got
Status code, the full response body, relevant headers (`Idempotent-Replayed`, `X-*`), and the `audit_id` if any.

<!-- DOM writes below this line -->
## DOM response (YYYY-MM-DD)
Cause, fix (or why it is not a bug: contract quote), release that fixes it, and a test ID that now covers it.
```


## DOM → Gavriel messages
DOM answers a CR inside that CR's file. Anything else DOM needs to tell Gavriel goes in `docs/requests/DOM-TO-GAVRIEL.md` (newest first). DOM never routes messages through Dvir.
