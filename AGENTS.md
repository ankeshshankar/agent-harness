# AGENTS.md

This is the project guide that every coding agent reads first. It is tool-neutral: Claude Code, Cursor and Codex all read it. Keep it short and exact. The flow and the roles come from `.agents/`; the rules that are specific to your project go in the last section.

The project name is `project.name` in `agents.config.json`.

## How a request becomes a verified commit

One feature, seven artifacts. Do not collapse the steps.

| #   | Step        | Who             | Artifact                                  |
| --- | ----------- | --------------- | ----------------------------------------- |
| 1   | Scope       | planner         | `docs/plans/<task>.md`                    |
| 2   | Unknowns    | researcher      | `docs/research/<topic>.md`                |
| 3   | Design      | spec-writer     | `docs/specs/<Feature>.md`, `status: draft` |
| 3b  | Spec review | spec-reviewer   | READY or REVISE, one lens per run         |
| 4   | **Approve** | **human**       | flips `draft` to `approved`               |
| 5   | Build       | builder         | code and tests, one packet per fresh session |
| 6   | Judge       | code-reviewer   | PROCEED or ITERATE with evidence          |
| 7   | Check       | **human**       | `docs/verification/<feature>.md`          |

Then a local commit, and a pull request only when asked.

- A human sets `status: approved`. That edit is the review record. The builder refuses to start before it.
- Every artifact carries `author`, `model` and `date` in its frontmatter.
- Verdicts are PASS (with evidence), FAIL (with file and line) or CANNOT-VERIFY (with the reason). A false "verified" is worse than an honest gap.
- A build is at most 3 rounds per packet. A third ITERATE goes to the human.
- Review is always a fresh context. No role dispatches another; the orchestrator does.

The method rules are in `.agents/playbook/` (also generated into `.cursor/rules/`). The orchestrator's procedure is `.agents/skills/orchestrate/SKILL.md`.

## Roles

Source: `.agents/roles/<role>.md`. Generated copies: `.claude/agents/`, `.cursor/agents/`, `.codex/agents/` (the kit's own repository also generates `plugins/agent-harness/agents/`).

<!-- agents:start -->

| Agent | Source role | Tools | Tier | Use for |
| --- | --- | --- | --- | --- |
| `builder` | builder | write | standard | Implements ONE approved spec packet (code and its tests), following the project's rules. |
| `code-reviewer` | code-reviewer | readonly | reasoning | Judges a change against the project's rules and the spec it claims to implement, returning PASS / FAIL / CANNOT-VERIFY per criterion with real evidence. |
| `dependency-manager` | dependency-manager | write | reasoning | Changes a dependency, version pin, peer range or package-manager setting anywhere in the project. |
| `planner` | planner | readonly | standard | Decomposes a request into a plan with explicit gates, unknowns and an iteration budget. |
| `release-manager` | release-manager | write | reasoning | Owns release and deploy configuration (build profiles, environments, pipelines, the update-versus-new-build decision, versioning). |
| `researcher` | researcher | readonly | standard | Researches an unknown (a library, a platform behaviour, a constraint, an API question) and returns a dated, sourced brief with a recommendation and its cost. |
| `spec-reviewer` | spec-reviewer | readonly | reasoning | Reviews a draft spec with fresh context before it is approved, through one lens per dispatch (clarity, fit with the code, or the build plan), and returns BLOCKING / SHOULD-FIX / NIT findings with evidence. |
| `spec-writer` | spec-writer | readonly | reasoning | Designs a feature's contract (behaviour, interfaces, data and state ownership, error mapping, write safety, security, observability) and writes the spec that gates implementation. |

<!-- agents:end -->

Skills are in `.agents/skills/`: `orchestrate`, `new-feature`, `spec-write`, `research-brief`, `pr-review`, `verify`, `upstream-request`, `init`, `memory-init`.

## Where things live

| What | Where |
| --- | --- |
| Agent roles, skills, method rules (source of truth) | `.agents/` |
| Config: project name, commands, paths, models, targets | `agents.config.json` |
| Generated agent files (do not edit) | `.claude/`, `.cursor/`, `.codex/` |
| Plans, specs, research, upstream requests | `docs/plans/`, `docs/specs/`, `docs/research/`, `docs/upstream-requests/` |
| Build briefs, packet slices, build logs | `docs/handoff/` |
| Human check records | `docs/verification/` |
| Document templates | `docs/templates/` |
| Memory convention | `docs/memory-format.md` |
| What is in flight | `STATE.md` |
| Your project's rules | `docs/rules/` |
| Local scratch, logs, reports (git-ignored) | `.agent-harness/` |

All paths can be changed under `paths` in `agents.config.json`.

## Commands

```bash
node scripts/sync-agents.mjs          # regenerate every agent file from .agents/
node scripts/sync-agents.mjs --check  # exit 1 if a generated file is stale (use in CI)
node scripts/verify.mjs               # run lint, typecheck, test, verify in order; PASS or FAIL
```

`node scripts/verify.mjs` runs the commands set in `agents.config.json` under `commands`. A command that is not set is skipped and the output says so. A run where nothing was configured fails.

Packet scripts, used by the `orchestrate` skill (details in `scripts/hooks/README.md`):

```bash
scripts/agents/run-packet.sh <brief> <packet> [--worktree] [--dry-run]   # one packet, fresh headless session
node scripts/agents/packet-slice.mjs --brief <brief> --packet <id>       # cut one packet's slice (--check, --all)
node scripts/agents/queue-brief.mjs <brief> [--dry-run]                  # queue every packet of a brief
node scripts/agents/log-round.mjs --log <log> --show <id>                # one packet's row, not the whole log
node scripts/agents/self-check.mjs <files>                               # cheap check of edited files
scripts/bin/check-lane.sh <label> -- <command>                           # one whole-repo job at a time
scripts/agents/clean-worktrees.sh --dry-run                              # list finished packet worktrees
```

The brief is `docs/handoff/<feature>-build-brief.md`, the log `docs/handoff/<feature>-build-log.md`; templates are in `docs/templates/`.

After you edit a role, a skill or the config, run the sync and commit the source and the generated files together.

## Your project's rules

<!-- FILL THIS IN. Everything above is the method; everything below is yours. -->

Replace this section. Agents follow what you write here and in `docs/rules/` over anything in `.agents/` that is about your stack.

- **Stack and layout:** language, framework, folder layout, where new code goes.
- **Commands:** how to run the app, lint, type check, test one file, test everything. Put the real commands in `agents.config.json` under `commands`.
- **Naming and structure rules:** the conventions a reviewer should enforce.
- **Security and privacy rules:** what is sensitive, what must never be logged or committed.
- **Commands that need a human:** add to the list in `.agents/playbook/20-side-effects.md`, for example your deploy and migration commands.
- **Release and deploy files:** the files the release-manager owns.
- **Dependency rules:** which versions are pinned on purpose and why, and where decisions are recorded.
- **Rules files:** list them here, one line each, with the paths they apply to.

| Paths | Rule file |
| --- | --- |
| (add a row per rules file) | `docs/rules/<name>.md` |
