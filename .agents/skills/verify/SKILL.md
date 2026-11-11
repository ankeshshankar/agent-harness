---
name: verify
description: Check that a change passes and report the real output. Use before saying any work is done, when asked "does it pass", or when a check fails and you need to know exactly what and why.
---

# verify

Follow the steps in order. Do not skip one because it "probably passes".

## Step 1 - Who are you?

- **You are a subagent** (any role): run the **narrow** checks in Step 2 only. The orchestrator runs the full gate.
- **You are the orchestrator** (the main chat) and no subagent is running a test run: you may run the full gate in Step 3.

## Step 2 - Narrow checks (everyone)

Run each command in this order and keep the real output:

1. The project's lint or self-check on every file you created or edited.
2. The tests for what you changed: `{{commands.test}}`, limited to those files.

If a brief or dispatch prompt lists different acceptance commands, run those instead. Never pass worker-count flags.

## Step 3 - The full gate (orchestrator only, one at a time)

```bash
node scripts/verify.mjs
```

It runs the configured lint, type check, test and verify commands in order and prints one result line per step and a final PASS or FAIL. A skipped step means that command is not set in `agents.config.json`. Never start a second gate while one runs. Record the exit code and the test summary line.

## Step 4 - When something fails

1. Read the failing output. Name the file and line.
2. **Fix the code. Never fix the check.** Never edit lint, formatter or test configuration, a threshold or a baseline. Never add `.skip`, `.only` or a lint-disable comment.
3. If the failure is in a file you did not touch, **do not fix it.** Report it under OUT-OF-SCOPE.
4. If you believe the check itself is wrong, stop and say which rule and why. That is a question for the human, not an edit.
5. Re-run the same command. Repeat at most 3 times, then stop and report.

## Step 5 - Reply in exactly this shape

```
COMMANDS:
  <command> -> exit <code> - <summary lines> - log <path>
  (one block per command)
VERDICT:
  PASS: <what passed, with the line of output that proves it>
  FAIL: <file:line - what failed>
  CANNOT-VERIFY: <what, and why - device, credential, environment>
OUT-OF-SCOPE: <failures in files you did not touch> | none
```

## Rules that make this report trustworthy

- **Quote real output.** Never write "all checks passed" without the line that says so.
- **"Not run" is honest; a guess is not.** If you did not run a command, write `not run` and why.
- A passing gate proves the code follows the project's checks. It does not prove the feature works in the real environment. Always list what needs the real environment as CANNOT-VERIFY; that is expected and is never a failure on your part. A false PASS is.
