---
name: new-feature
description: "Build one feature packet from an approved spec - code, tests, mutation checks, and a report with evidence. Use as the builder, only when the spec or packet is approved."
---

<!-- generated from .agents/skills/new-feature/SKILL.md — do not edit. Edit the source, then run: node scripts/sync-agents.mjs -->

# new-feature

The packet beats this skill where they disagree.

## Step 0 - Stop

Stop with `STOPPED BECAUSE:` and the evidence if:

- The packet frontmatter is not exactly `spec_status: approved` (no packet: `docs/specs/<Feature>.md` is missing or not `status: approved`).
- An edit would fall outside the packet's **Create / edit** list (no brief: outside this feature).
- You need a dependency, a version change, release or deploy configuration, or a generated folder the spec does not list.
- A shared component or token is missing: file an upstream request (`upstream-request`), then stop.
- A user-visible string is not in the spec.
- The spec and the code disagree, or the spec is ambiguous.

**Never** set a `status:` field. **Never** run `git commit`, `git add`, `git stash`, `git checkout`, `git restore`, `git reset`, or any publish or deploy command.

## Step 1 - Read

1. The packet file `docs/handoff/<feature>/<packet>.md`: hard rules, risk points, report format and its spec sections. It is your whole brief and spec. Never open `docs/specs/` or the build brief. Note each TESTS item and which are `[M]`.
2. One existing feature in the project that is closest to this one. Read its entry file and one test. Copy those patterns; do not invent a second way.

**Check:** the file list and the TESTS items. The packet must allow every file you will touch.

## Step 2 - Build bottom-up

Start at the lowest layer the packet touches and work up. A layer calls only the one below it. Validate data where it enters. Use the project's rules in `docs/rules/` for layering, naming and structure.

- Interfaces and schemas first, then logic, then presentation, then wiring.
- Fakes and stubs only where the packet says the real piece does not exist yet; mark each clearly and import it from one place only.
- After each file, run the project's lint or self-check on it. Fix every FAIL first. Justify every warning in the report.

## Step 3 - Copy, errors, observability, flag

1. **Text.** Every user-visible string is the spec's text, kept in the one place the project uses for strings.
2. **Errors.** Map every error the spec names. A failed first load, a failed refresh, an empty result and a cancelled request are different states. Never `catch { return [] }`.
3. **Observability.** Add the spec's signals at the named places with the listed properties: enumerations, booleans, bounded integers, never names, phones, ids, URLs, codes, free text or error text. If the spec missed an interaction, add it and list it under ADDED BEYOND SPEC.
4. **Flag.** Apply the spec's ROLLOUT. None in the spec: no gate.

## Step 4 - Tests

User-observable: a rendered element, a returned value, a signal (compare the whole property object), a thrown error. Name each test for its TESTS item. Do not use `.only`, `.skip`, snapshots or log statements as assertions.

```bash
<test command, limited to your test files> > <scratch>/<packet>-test.log 2>&1; echo "exit $?"
```

**Check:** exit 0. Each TESTS item maps to a test name in the file. Quote the exit code and the test summary line.

## Step 5 - Two mutations, `[M]` only

Make **2** mutations, only on `[M]` items. Copy the file aside, break it (flip a condition, drop a signal, return the wrong state), run the narrow test quietly, quote the single FAIL line, restore byte-identically:

```bash
cp <file> <scratch>/orig
# break the behaviour
<narrow test command> > <scratch>/<packet>-mut.log 2>&1; echo "exit $?"
cp <scratch>/orig <file> && cmp <scratch>/orig <file>   # prints nothing
```

A survivor: tighten the test, then mutate again.

## Step 6 - Final checks

Each command's output goes to `<scratch>/<packet>-<cmd>.log`: the lint or self-check on every file you created or edited, and the tests for your files. **Check:** all exit 0, else report the exit, the summary line and why.

## Step 7 - Report

Write this to `<scratch>/<packet>-r<round>-builder.md` (see the role footer). The reply is the footer's 15-line builder summary. TESTS ITEMS SATISFIED names go one per line in this file.

```
PACKET: <P<n>, round <r>> | <feature>
FILES CHANGED: <path> (created|edited) - one per line, every file
ACCEPTANCE:
  <command> -> exit <code> - <summary line> - log <scratch>/<packet>-<cmd>.log
TEST RUN: exit <code> - <test summary line>
TESTS ITEMS SATISFIED: <TESTS n>: <file> > <exact test name>
SELF-MUTATIONS (2, [M] only): <file:line - change - FAIL line - cmp clean>
SELF-CHECK WARNINGS: <warning and why> | none
ADDED BEYOND SPEC: <signal {props} - why> | none
DEVIATIONS FROM SPEC: <section - what - why> | none
CANNOT-VERIFY: <item - why> | none
STOPPED BECAUSE: <condition - evidence> | n/a
OUT-OF-SCOPE NOTICED (not fixed): <item> | none
```

## Honesty

A claimed test name missing from the file pauses the feature. Report the exit code and summary line only. Use the file-edit tool for edits: no `sed -i`, no shell heredoc rewrites of source, no "rest unchanged" comments, no TODO placeholders, no commented-out code.
