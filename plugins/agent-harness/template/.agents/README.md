# .agents: one definition, every tool

This folder is the **source of truth** for the agent roles, skills and rules. The copies in `.claude/`, `.cursor/`, `.codex/` and `plugins/agent-harness/` are generated from it by `node scripts/sync-agents.mjs` and carry a "generated from .agents/..., do not edit" header. Edit a generated file and your change is gone at the next sync.

```
.agents/roles/<role>.md          one agent role (frontmatter below)
.agents/skills/<name>/SKILL.md   one skill: a procedure for the current context
.agents/playbook/role-footer.md  appended to every role body
.agents/playbook/<rule>.md       becomes a Cursor rule (.cursor/rules/<rule>.mdc)
agents.config.json               targets, names, models, paths, commands
```

## Role frontmatter

```yaml
---
name: builder # role id; must match the file name
description: ... # when to dispatch it
tools: readonly | write # readonly = analysis only, no edit tools
model: light | standard | reasoning # a TIER, never a model name
---
```

The body is plain markdown, copied through. Only frontmatter is rewritten per tool. `{{paths.specs}}`, `{{commands.test}}`, `{{project.name}}`, `{{packageManager}}` and `{{defaultBranch}}` are replaced from `agents.config.json`; a placeholder with no value is an error.

`tools` decides the tool list. Neither list includes `Agent`: no role dispatches another, because a role that can dispatch its own reviewer can approve its own work.

| Tier        | Means                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| `light`     | mechanical, one right answer, no rule to weigh                         |
| `standard`  | implements or judges against rules that already exist                  |
| `reasoning` | derives a rule that does not exist, or weighs a trade-off with no precedent |

Tiers name task weight, not model speed, so a vendor rename never forces a role edit. Map tiers to model names in `agents.config.json` under `models.<tool>.tiers`; override one role with `models.<tool>.roles`; pin effort with `models.<tool>.efforts`.

## Roles

| Role               | Tools    | Tier      | Does                                                         |
| ------------------ | -------- | --------- | ------------------------------------------------------------ |
| `planner`          | readonly | standard  | plan and packetised build brief                              |
| `spec-writer`      | readonly | reasoning | the spec that gates the build                                |
| `spec-reviewer`    | readonly | reasoning | one review lens per dispatch: clarity, fit, plan             |
| `builder`          | write    | standard  | one approved packet: code and tests                          |
| `code-reviewer`    | readonly | reasoning | PASS / FAIL / CANNOT-VERIFY per criterion, PROCEED or ITERATE |
| `researcher`       | readonly | standard  | dated, sourced brief on an unknown                           |
| `release-manager`  | write    | reasoning | release and deploy configuration                             |
| `dependency-manager` | write  | reasoning | dependency manifests and lock file                           |

The reviewer is deliberately at the same tier as the spec-writer and above the builder. A reviewer weaker than the builder it judges tends to rubber-stamp, and it is the last gate before a human.

## Skills

| Skill              | Use when                                                         |
| ------------------ | ---------------------------------------------------------------- |
| `orchestrate`      | building an approved spec in packets: build, check, review       |
| `new-feature`      | the builder's procedure for one packet                           |
| `spec-write`       | producing a spec                                                 |
| `research-brief`   | producing a research brief                                       |
| `pr-review`        | reviewing a diff, PR, branch or packet                           |
| `verify`           | checking a change passes and reporting real output               |
| `upstream-request` | a shared component or token your team owns elsewhere is missing  |
| `init`             | scaffolding the kit into a project (from the plugin)             |
| `memory-init`      | explaining and scaffolding the memory convention                 |

Invoke a skill with `/<name>` in Claude Code and Cursor, `$<name>` in Codex. A skill is a procedure in the current context; an agent is a fresh context or an independent judge. Cursor and Codex read `.agents/skills/` in place; the sync copies skills to `.claude/skills/` and the plugin.

## Running a role when the tool has no subagents

The role is only a prompt:

```
Read .agents/roles/spec-writer.md and follow it for the rest of this task.
```

`tools: readonly` is then a promise you keep, not a sandbox the tool enforces.

## Changing a role

1. Edit `.agents/roles/<role>.md`.
2. `node scripts/sync-agents.mjs`
3. Commit the source and the generated files together.

`node scripts/sync-agents.mjs --check` exits 1 if any generated file is stale. Use it in CI.
