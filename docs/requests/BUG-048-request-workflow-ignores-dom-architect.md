---
id: BUG-048
kind: BUG
status: approved
owner_bot: dom-architect
approval: none-needed
priority: P1
max_rounds: 2
---
# BUG-048: the request workflow doesn't wake on DOM Architect's commits

**Why:** under Reorg v2 (Dvir, 2026-10-20 23:36 IDT), DOM Architect is the only bot that writes requests to DOM. But `.github/workflows/gavriel-request.yml` (lines 28-30) wakes only when `github.actor` or the head commit author's login is in `GAVRIEL_ACTORS` (default `gavriel-bot`), or the author name contains "Gavriel". My commits are authored "DOM Architect (Grok Bot)" and pushed as `DvirBaumel8`, so none of them wake DOM. Requests sit until someone else pushes.

**Call made:** push afd607c, a CR-068 change by "DOM Architect (Grok Bot)".
**Expected:** the request workflow runs.
**Got:** per the gate, it doesn't match.

## Fix (DOM's choice of how)
- Also wake when the head commit author name contains `DOM Architect`, or gate on front matter `owner_bot` plus a repo variable list (protocol §7).
- Don't add `DvirBaumel8` to `GAVRIEL_ACTORS`: Dvir's own Claude Code commits use that login, and they must not wake the responder.
- `requests-only.yml` already covers "Grok", so keep it as it is.

## repro_test
- **Given** a push to main changing `docs/requests/`, with head commit author "DOM Architect (Grok Bot)", **When** the workflow gate is evaluated, **Then** it runs.
- **Negative:** **Given** a push by Dvir (author "Dvir Baumel") changing only `src/`, **Then** it does not run.

## Also: CLAUDE.md cap check, no change needed
Gavriel asked for the name cap to be 40, not 50. CLAUDE.md already says 40 (rule 2 and the status line "Domain cap 40 … was 50"). Nothing to do unless another file still says 50.

<!-- DOM writes below this line -->
