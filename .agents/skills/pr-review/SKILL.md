---
name: pr-review
description: Review a diff, PR or packet against the project's rules and the spec. Returns PROCEED or ITERATE with evidence. Use after every build, with fresh context.
---

# pr-review

You report findings. You **never edit** the files under review.

**Round 2 or later.** The prompt has the previous findings, `git diff` since round n-1's snapshot, and new files. Re-judge those findings and the new files only.

## Step 1 - What changed

`{{paths.handoff}}/<feature>/<packet>.md` is the whole brief and spec. Never open the full spec or brief. The prompt's file list is the change; otherwise use `git status --short`, `git diff --stat <base>` and `git ls-files --others --exclude-standard`. Read untracked files. With a snapshot: `diff -u <snapshot>/<path> <path>`. Every finding points into that list.

## Step 2 - Checks

Each command's output goes to `<scratch>/<packet>-<cmd>.log`. Quote the exit code and the summary line only.

- The project's lint and type check on the changed files.
- The tests for the changed files (`{{commands.test}}` limited to them).
- The acceptance commands, if you were given them.

Quote the output; do not re-walk what a tool already checks. A FAIL is BLOCKING.

**Report honesty.** `grep -nF "<exact name>" <file>` for every claimed test name. Missing: BLOCKING **REPORT MISMATCH**.

## Step 3 - Rules

Read `AGENTS.md` and the rules in `{{paths.rules}}/` whose scope matches a changed file.

## Step 4 - Checklist

Answer **YES / NO / N/A** with a file:line. A NO is a finding.

1. Touched spec sections match the spec. A diverging improvement is still a finding.
2. Only listed files changed. No drive-by reformat, refactor or fix.
3. No check was edited to pass (lint, formatter, test, threshold, baseline).
4. Cache keys, lookups and queries include every input that changes the response.
5. Freshness and timeouts fit the data (a balance is not a news feed).
6. Writes state idempotency, retry and ordering as the spec does. A timeout does not prove the server did nothing.
7. Failed first load, failed refresh, empty and cancelled are different states. A `catch` that returns an empty list is BLOCKING.
8. State lives where the spec says it lives; no second copy of server data.
9. Layers call only the layer below them, as the project's rules say.
10. User-visible text comes from where the spec says (one place, not scattered).
11. Each spec'd signal fires from the named place with the listed properties. A test compares the whole property object.
12. Every interaction and mutation outcome has a signal, or the spec exempts it.
13. No personal data, free text, id, URL or error text in a signal property.
14. Flagged: registered with its default, gated, both states tested. Not flagged: no gate.
15. Nothing sensitive in a URL, a route parameter or a public configuration value.
16. Sign-out or reset clears every cache, store and secret the feature added.
17. A new dependency or platform change states its release impact.
18. Stubs and fakes: only the seam imports one; tests never do; marked clearly.
19. Nothing sensitive is logged: no secret, token, personal data or payload.

## Step 5 - Mutants

At most **3**, only `[M]` TESTS items. Break shipped code, run the narrow test quietly, quote the single FAIL line, restore byte-identically:

```bash
cp <file> <scratch>/orig
# break the behaviour
<test command for that test> > <scratch>/<packet>-mut.log 2>&1; echo "exit $?"
cp <scratch>/orig <file> && cmp <scratch>/orig <file>   # prints nothing
```

A survivor is SHOULD-FIX. Never leave a mutant in place.

## Step 6 - Report

Write this to `<scratch>/<packet>-r<round>-review.md` (see the role footer). Every criterion is PASS, FAIL or CANNOT-VERIFY with evidence. The reply is the footer's 15-line reviewer summary.

```
CHANGE: <base or snapshot> - <n> files
CHECKS RUN:
  <command> -> exit <code> - <summary line> - log <path>
REPORT HONESTY: <names found | REPORT MISMATCH: name, file>
CHECKLIST: <1..19 YES / NO / N/A, file:line>
MUTANTS (at most 3, [M]): <file:line - change - killed by <test> | SURVIVED - cmp clean>
FINDINGS:
  BLOCKING:
    - <file:line> - <rule> - <what is wrong>
  SHOULD-FIX:
    - ...
  NIT:
    - ...
CANNOT-VERIFY: <what - why> | none
VERDICT: PROCEED | ITERATE
```

## Severity

- **BLOCKING:** a structural rule; a silent failure (unvalidated boundary, swallowed error, no idempotency stance, wrong or cross-user cache key, leaked secret); a missing spec'd signal; a failed check; REPORT MISMATCH; a check edited to pass.
- **SHOULD-FIX:** a discipline break that will not fail at runtime; a surviving mutant; a test gap.
- **NIT:** genuinely minor. No rule and no line: sharpen or drop.
- **VERDICT:** ITERATE on any BLOCKING or SHOULD-FIX; otherwise PROCEED.
