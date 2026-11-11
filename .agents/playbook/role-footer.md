## Every role, every tool

Added to every role by `node scripts/sync-agents.mjs`.

- Follow a named skill from `.agents/skills/<name>/SKILL.md`, in order.
- Read `AGENTS.md` and the project's own rules in `{{paths.rules}}/` before you start. They override anything here that is about the stack.
- If your prompt lists no checks, run the narrow check for what you touched: the project's test command limited to the changed files. Never run the full gate (`node scripts/verify.mjs`) unless you are the orchestrator.
- **First line of every reply:** the model you are running as.
- **Reply in 15 lines or fewer.** Write the full report to `<scratch>/<packet>-r<round>-<role>.md`. `<scratch>` is the directory the dispatch prompt names; if none is named, use `{{paths.reports}}`. The reply is the short summary. If you cannot write the report file, put the full report in the reply instead.
- The builder report file holds SELF-MUTATIONS, DEVIATIONS, ADDED BEYOND SPEC and CANNOT-VERIFY. The orchestrator greps those sections every round and passes them to the reviewer.

Builder reply:

```
<model>
STATUS: DONE | BLOCKED | PARTIAL
REPORT: <scratch>/<packet>-r<round>-builder.md
<changed paths, max 10, then "+N more">
<acceptance command> exit <code>
TESTS ITEMS SATISFIED: one per line in the report file
<blocker, one line each>
```

Reviewer reply:

```
<model>
VERDICT: PROCEED | ITERATE
REVIEW: <scratch>/<packet>-r<round>-review.md
BLOCKING: <n>  SHOULD-FIX: <n>  NIT: <n>
<file:line> - <BLOCKING finding, one line each>
```

- Never run the commands listed in `.agents/playbook/20-side-effects.md` without a human confirming in the same turn.
- If a command guard blocks a command, or a stop condition holds, report it and stop.
