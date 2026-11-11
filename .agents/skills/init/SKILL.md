---
name: init
description: Scaffold the agent-harness project files (AGENTS.md, agents.config.json, .agents/, sync and verify scripts, doc templates) into the current project. Lists every file first and never overwrites without asking. Use once per project, after installing the plugin.
---

# init

A plugin cannot write files into your project by itself. This skill does it, with you in control. Follow the steps in order.

## Step 1 - Find the template

- Run from the plugin: the template is at `${CLAUDE_PLUGIN_ROOT}/template`.
- Run without the plugin (the kit is committed in this repository): the template is the repository's own files. Say so, and stop: nothing to scaffold. Offer `node scripts/sync-agents.mjs` instead.
- If `${CLAUDE_PLUGIN_ROOT}` is empty and no template folder exists, ask the human where the template is. Do not guess.

## Step 2 - Plan, and show it

Walk the template and compare each file with the current project. Print a table before writing anything:

| File | State | Action |
| --- | --- | --- |
| `AGENTS.md` | missing / exists, same / exists, different | create / skip / ask |

Rules for the table:

- **Missing**: create.
- **Exists and identical**: skip.
- **Exists and different**: never overwrite. Show a short diff and ask: keep mine, take the template, or merge. The default is keep mine.
- Never write outside the current project folder.
- Never write `.env`, credentials or anything from the home folder.

Ask the human to confirm the whole table once (numbered options: write all the creates, choose file by file, cancel). Write nothing until they answer.

## Step 3 - Write

Copy each confirmed file with its folder structure. Keep file modes (scripts stay executable). Add `.agent-harness/` to `.gitignore` (create the file if missing; add the line only if it is not already there).

## Step 4 - Fit it to the project

Ask, as numbered questions with a recommendation, then edit `agents.config.json`:

1. `project.name`.
2. The project's real commands: `commands.lint`, `commands.typecheck`, `commands.test`, `commands.verify`. Leave a command empty if the project has none; the gate will say it skipped it.
3. `packageManager` and `defaultBranch`. Read them from the project first (lock file, `git branch`) and propose what you found.
4. `rolePrefix`, if the human wants agent names such as `acme-builder`. Default: none.

Then tell the human to fill the "Your project's rules" section of `AGENTS.md` and to put stack rules in `{{paths.rules}}/`.

## Step 5 - Generate and check

```bash
node scripts/sync-agents.mjs
node scripts/sync-agents.mjs --check
node scripts/verify.mjs
```

Report each exit code. Do not commit; tell the human what changed (`git status --short`).

## Reply

```
SCAFFOLDED: <n created, n skipped, n kept as the human's own>
CONFIG: <fields set>
CHECKS: <command> -> exit <code>
NEXT: fill "Your project's rules" in AGENTS.md; add the memory convention with the memory-init skill if wanted
```
