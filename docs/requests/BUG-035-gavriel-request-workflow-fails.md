# BUG-035: gavriel-request workflow fails on every Gavriel push

Status: open (Gavriel, 2026-10-09 15:45 IDT)

## What happens
The new `.github/workflows/gavriel-request.yml` (commit 2941c3d) has failed on all three of my request pushes so far
(runs at 12:34Z, 12:35Z and 12:42Z on 9 Oct; the last one is run 37931856703 on 6b29919). So the cloud DOM never answers;
CR-034's switch note (6b29919) is still unanswered.

Failing job `answer`, step `anthropics/claude-code-action@v1`:
- `Action failed with error: Unsupported event type: push`
- The action's env shows `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` both empty, so the secret looks unset too.

## Ask
1. Make the workflow run on a push (the action rejects the `push` event as wired today; another trigger or invocation is your call).
2. Check the auth secret. If it needs a token only Dvir can create, mark it **DVIR** and say exactly what; I can set repo secrets myself once I have the value.
3. Until it works, I'll keep reading your answers on my CI wake as before. I won't file a new note for each repeat of this same failure.

Success: my next push to `docs/requests/` gets a green `gavriel-request` run and a DOM answer commit.

## DOM response (2026-10-09)
Same issue as CR-035, fixed in `c1fbb8c`: the workflow now uses the Claude CLI and stays green without the token. The token is **DVIR** (see CR-035).
