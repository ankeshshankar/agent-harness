---
name: orchestrate
description: "Run an approved spec through packets, one at a time - build, check, fresh-context review, decide - and verify what the agents report. Use when building a feature from an approved spec. Prefer scripts/agents/run-packet.sh when installed; in-chat is the fallback."
---

<!-- generated from .agents/skills/orchestrate/SKILL.md — do not edit. Edit the source, then run: node scripts/sync-agents.mjs -->

# orchestrate

When a role exists for the work, you write no feature code. Subagents build and review; **you verify that what they say is true.**

## Mode

Preferred: `scripts/agents/run-packet.sh <brief> <packet>` when the packet scripts are installed. It runs one packet in a fresh headless session, refreshes the slice first, refuses a spec that is not approved, never pushes or deploys, and commits only in a `--worktree` run. It prints one `RESULT <packet> PROCEED|ITERATE|BLOCKED ...` line; read that line, then a report only on FAIL or ITERATE. Exit codes: 0 PROCEED, 1 ITERATE or BLOCKED, 2 a script or CLI error. In-chat is the fallback: follow the steps below by hand.

The scripts this skill uses (all optional; each has a by-hand fallback below):

| Need | Command |
| --- | --- |
| Run one packet headless | `scripts/agents/run-packet.sh <brief> <packet> [--worktree] [--model <m>] [--effort <e>] [--defer-verify] [--dry-run]` |
| Cut a packet's slice | `node scripts/agents/packet-slice.mjs --brief <brief> --packet <id>` (`--all`, `--check`) |
| Queue a whole brief | `node scripts/agents/queue-brief.mjs <brief> [--dry-run]`, then `node scripts/hooks/packet-runner.mjs --status` (`--pause`, `--resume`) |
| Log a round, read a row | `node scripts/agents/log-round.mjs --log <log> --packet <id> --round <n> --verdict <V> --summary "..."`; `--show <id>` |
| Check edited files | `node scripts/agents/self-check.mjs <files>` |
| One whole-repo job at a time | `scripts/bin/check-lane.sh <label> -- <command>`; `scripts/bin/ram-ok.sh` |
| Compact a status table | `node scripts/hooks/status-delta.mjs <file>` |
| Remove finished worktrees | `scripts/agents/clean-worktrees.sh [--dry-run]` |

The brief is `docs/handoff/<feature>-build-brief.md` (template `docs/templates/build-brief.md`) and the log is `docs/handoff/<feature>-build-log.md` (template `docs/templates/build-log.md`). The scripts read the brief's headings by name, so keep them. The full list is in `scripts/hooks/README.md`.

Reports are `<scratch>/<packet>-r<round>-{builder,review}.md`; each reply is 15 lines or fewer. Every round, grep the builder report for SELF-MUTATIONS, DEVIATIONS, ADDED BEYOND SPEC and CANNOT-VERIFY and pass those sections to the reviewer. Open the rest of a report only on FAIL, ITERATE, or the honesty check.

**Names.** People do not follow bare packet ids. Anything shown to the user uses the packet's `- **Name:**` line, with the id in brackets or left out. No Name line: the id.

## Before anything

Read `AGENTS.md` and the rules in `docs/rules/` fresh. Before the first packet, if the brief has an `## Open questions` section, ask them all at once (numbered, 2 to 4 options, one recommendation) and do not build until they are answered.

## Dispatch

- Too big for one spec: planner
- Unknown fact (library, platform, API): researcher, `research-brief`
- Feature, interface, ambiguous spec: spec-writer, `spec-write`
- Draft spec, before approval: spec-reviewer **three times in parallel**, fresh context, one lens each (`clarity`, `fit`, `plan`). Pass only the spec path and the lens. BLOCKING findings go back to the spec-writer; SHOULD-FIX by judgement; QUESTIONS to the human. Re-run only the lenses that had BLOCKING findings. Record one row per spec in `docs/handoff/spec-review-log.md`: date, spec, lens counts, later amendments.
- Approved spec: builder, `new-feature`
- Judge a build: code-reviewer, `pr-review`
- Dependency or version: dependency-manager
- Pipeline, release, deploy config: release-manager
- Missing shared component or token: any role, `upstream-request`
- "Does it pass?": you, `verify`
- Packets: you, this skill

Human only: `status: approved`, the final check. `draft` means stop. No role dispatches another. A typo or one string: edit it yourself, then run the narrow check.

## Across packets

Packets with `Depends on: none` and disjoint `Files:` may run in parallel, each in its own worktree from HEAD. Merge finished branches into the current branch **one at a time**. After each merge run the type check and the tests related to the merged files. The full gate runs **once per finished feature**, not per packet. A failure blocks further merges. Run one heavy job at a time (a full test run, a native build).

## Limits

Whole-project commands (the full gate, the full test run, a full build) run one at a time. Give the test runner file names; a bare run counts as whole-project. Do not set worker-count flags. Stop dev servers and emulators you started.

No `git push`. One-line subject, no generated attribution. Commit only when asked, except the one local commit in a worktree run after the reviewer says PROCEED and the gate passes. No `checkout`, `restore`, `reset` or `stash` except `stash create`. Dependencies go through the dependency-manager; release files through the release-manager.

## Reporting

Not run: write "not run". **PASS** (evidence), **FAIL** (file:line), **CANNOT-VERIFY** (why). List environment, device and credential gaps. End with files changed and what is left.

## Context rules

- Long output goes to a file (`<cmd> > <scratch>/<packet>-<cmd>.log 2>&1; echo "exit $?"`, then `grep` or `tail`). Only exit codes and summary lines enter the chat.
- Never read the build log whole. With `scripts/agents/log-round.mjs` installed, read one packet's row with `--show <packet>`.
- Keep `STATE.md` and the build-log row current. Never stop work or tell the user to start a new chat because of context.

## Before the packet

1. The spec is `status: approved` (`grep -n '^status:' docs/specs/<Feature>.md`). If not, stop.
2. `docs/handoff/<feature>-build-brief.md` exists (from `docs/templates/build-brief.md`) with the HARD RULES, RISK POINTS, REPORT FORMAT and PACKETS headings and, per packet: `Spec:`, `Depends on:`, create/edit, do not touch, acceptance, stop. Otherwise dispatch the planner; the human approves.
3. `docs/handoff/<feature>-build-log.md` exists (from `docs/templates/build-log.md`). Scratch lives outside the repo or under `.agent-harness/`.

## Step 1 - Baseline the packet (never stage, never commit)

```bash
BASE=$(git stash create); BASE=${BASE:-$(git rev-parse HEAD)}; echo "$BASE"
git ls-files --others --exclude-standard > <scratch>/P<n>.untracked
mkdir -p <scratch>/P<n>-pre && rsync -R <each EXISTING file on the packet's create/edit list> <scratch>/P<n>-pre/
shasum -a 256 <the same files>
```

`git stash create` writes a commit object and does not touch the tree. Never plain `git stash`. Log `BASE`, the snapshot and the hashes before dispatch.

## Step 2 - Builder

Slice the packet if `scripts/agents/packet-slice.mjs` is installed (`--brief <brief> --packet P<n>`); otherwise write the packet file by hand from `docs/templates/packet.md`. Over budget or an unresolved `Spec:` reference: stop; the planner splits it. Dispatch the builder:

```
Read only docs/handoff/<feature>/<packet>.md, not the spec or the build brief.
Report: <scratch>/<packet>-r<round>-builder.md.
```

## Step 3 - Check (every round)

1. **Round checks.** Acceptance commands and the brief's extras, each to `<scratch>/<packet>-<cmd>.log`. Note exit codes and the test summary line. Red elsewhere is not this packet's.
2. **Scope.**

   ```bash
   git diff --stat $BASE -- <tracked files on the list>
   diff -u <scratch>/P<n>-pre/<path> <path>        # existing untracked file on the list
   git ls-files --others --exclude-standard | comm -13 <scratch>/P<n>.untracked -   # new files
   ```

   Any changed file not on the list is a **scope break**.

3. **Report honesty.** For every test name under TESTS ITEMS SATISFIED, `grep -nF "<exact name>" <file>`. One missing name is a **report mismatch**: log it as serious, **pause the feature**, tell the human.
4. **Mechanical checks.** Run the project's own lint or self-check on every changed file (`scripts/agents/self-check.mjs` when installed).
5. **Self-mutations.** 2, only on `[M]` items, each with its FAIL line and a clean `cmp`. Otherwise a finding.

## Step 4 - Reviewer (fresh every round; never resume)

```
pr-review. Only docs/handoff/<feature>/P<n>.md.
Files <from Step 3>. BASE <BASE>. Pre-edit <scratch>/P<n>-pre.
Claims in the builder report: files changed, tests satisfied, and the grepped SELF-MUTATIONS, DEVIATIONS, ADDED BEYOND SPEC and CANNOT-VERIFY sections. Checks: <exits, test summary line>.
Report: <scratch>/<packet>-r<round>-review.md.
Round 2 or later: previous findings, `git diff <prior SNAP>`, new files. Re-judge those findings and new files only.
At most 3 `[M]` mutants; a survivor is SHOULD-FIX. PROCEED or ITERATE.
```

## Step 5 - Decide and log

- **ITERATE:** `SNAP=$(git stash create)`; copy to `<scratch>/P<n>-r<r>/`. Start a fresh builder, never a resumed one: packet file, file:line findings, changed files. Back to Step 3.
- **PROCEED:** the packet's checks all exit 0 (the packet's tests, the tests related to its changed files, the self-check, the type check). The full gate is deferred to the end of the feature unless the run says otherwise. Red in this packet's files: ITERATE. Red elsewhere: log it and tell the human.
- **Budget:** 3 rounds per packet (the build plus 2 fixes). A third ITERATE stops the feature: report to the human with the findings and your recommendation.
- **Switch rule:** two hard-rule breaks, or one report mismatch, across any two packets: pause and ask the human whether to change the builder's model.

Log every round in the build log: packet, round, verdict, findings, scope result, honesty result, and a one-line summary.

## End of the packet

Update the build-log row and `STATE.md`, then stop with one line: `RESULT <packet> PROCEED|ITERATE|BLOCKED rounds=<n> report=<path>`. BLOCKED means a mismatch, a guard denial, an unresolved slice, or a human decision. Never accept an unchecked report.

## Before the PR: docs that ship

The PR carries only docs that stay true after merge. Run `git diff --name-only main...HEAD -- docs/` and keep specs, contracts, research, upstream requests, verification records and decision records. Drop (after the human says yes) the feature's build brief, build log and packet slices, once every kept file that names them points at commit ids instead.
