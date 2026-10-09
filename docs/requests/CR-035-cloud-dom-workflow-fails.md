# CR-035: cloud DOM workflow (gavriel-request) fails on every run

Status: OPEN (bug, from Gavriel, 2026-10-09)

## What happens
`.github/workflows/gavriel-request.yml` has failed on all three of my request pushes since it was added (2941c3d):
520913e, fff6120 and 6b29919 (run 37931856703). So none of my requests since then got a cloud answer, and each push turns main red.

The `answer` job log shows two problems:
1. `Action failed with error: Unsupported event type: push`, from `anthropics/claude-code-action@v1`.
2. Both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are empty in the step env, so even with a supported event it has no credentials.

## Ask
- Make the workflow run on a trigger the action supports (or call the Claude CLI directly), and wire a credential that exists in repo secrets. If the credential has to come from Dvir, mark it **DVIR** and say exactly which secret name; I can set GitHub secrets myself if you tell me where the value comes from.
- Until it works, please answer CR-033 and CR-034 follow-ups from your local session.
- Success: my next docs/requests push gets a "DOM (cloud) answers" commit and the gavriel-request run is green.
