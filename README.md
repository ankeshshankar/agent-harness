# agent-harness

agent-harness is a set of agent roles, skills, hooks and scripts that move a coding task through a fixed path: plan, spec, human approval, build, review, verify. You define the roles and skills once in `.agents/`. A sync script generates the files that Claude Code, Cursor and Codex read. It is MIT licensed and has no npm dependencies.

## The flow

From a request to a verified commit:

1. **Plan.** The `planner` splits the request into steps, with gates, unknowns and an iteration budget.
2. **Research.** The `researcher` answers any unknown that blocks the plan, with a dated, sourced brief.
3. **Spec.** The `spec-writer` writes `docs/specs/<Feature>.md` with `status: draft`.
4. **Spec review.** The `spec-reviewer` reviews the draft three times, once per lens (clarity, fit with the code, build plan). It returns BLOCKING, SHOULD-FIX or NIT findings.
5. **Approval gate.** A human changes `status: draft` to `status: approved`. The builder refuses to start before that.
6. **Build.** The `builder` implements one packet per fresh session, with its tests and a report.
7. **Check.** The orchestrator runs the acceptance commands itself and compares the report with the diff. It does not trust the report.
8. **Review.** The `code-reviewer`, in a fresh context, returns PASS, FAIL or CANNOT-VERIFY per criterion, and PROCEED or ITERATE. A packet gets at most 3 rounds; a third ITERATE goes to the human.
9. **Verify gate.** `node scripts/verify.mjs` runs your lint, type check and tests. A human then checks what a machine cannot.
10. **Commit.** A local commit. A pull request only when you ask.

The `dependency-manager` and `release-manager` handle dependency and release changes. No role starts another role; the orchestrator does.

## What you get

### Roles

| Role | Does |
| --- | --- |
| `planner` | Splits a request into a plan with gates and an iteration budget. |
| `researcher` | Answers one unknown with a dated, sourced brief. |
| `spec-writer` | Writes the feature spec that gates the build. |
| `spec-reviewer` | Reviews a draft spec through one lens per run. |
| `builder` | Implements one approved packet, code and tests. |
| `code-reviewer` | Judges a change against the rules and the spec, with evidence. |
| `dependency-manager` | The only role that changes dependencies and version pins. |
| `release-manager` | Owns release and deploy configuration. |

### Skills

| Skill | Does |
| --- | --- |
| `orchestrate` | Runs an approved spec packet by packet: build, check, review, decide. |
| `spec-write` | Writes or amends a spec. |
| `new-feature` | The builder's procedure for one packet. |
| `pr-review` | Reviews a diff or packet and returns PROCEED or ITERATE. |
| `verify` | Runs the project's checks and reports the real output. |
| `research-brief` | Writes a research brief. |
| `upstream-request` | Files a gap in a dependency you own but do not edit here. |
| `init` | Scaffolds the project files from the plugin. |
| `memory-init` | Explains and scaffolds the memory convention. |

### Hooks

| Hook | Event | Default | Does |
| --- | --- | --- | --- |
| `guard-command` | PreToolUse, Bash | on | Denies force push to the default branch, publish and deploy commands, `rm -r` of the repo root or home, and `reset --hard` or `clean -f` on a dirty tree. Adds your own rules. |
| `read-guard` | PreToolUse, Read | on | Blocks a whole read of a text file over 40 KB and says to read a line range. |
| `context-guard` | UserPromptSubmit | on | Adds one reminder to save progress when the context passes 150,000 tokens. |
| `monitor-allow` | PreToolUse, Monitor | off | Auto-approves Monitor watches whose command only reads. |
| `heavy-gate-pre`, `heavy-gate-post` | PreToolUse, PostToolUse, Bash | off | Makes whole-repo jobs take turns and waits under memory pressure. |
| `packet-runner` | SessionStart | off | Starts queued packets in detached headless sessions. |

### Scripts

| Script | Does |
| --- | --- |
| `scripts/sync-agents.mjs` | Generates the agent files for each tool from `.agents/`. `--check` fails on drift. |
| `scripts/verify.mjs` | Runs the commands set in `agents.config.json`. Fails if none ran. |
| `scripts/agents/run-packet.sh` | Runs one packet in a fresh headless session, optionally in a git worktree. |
| `scripts/agents/packet-slice.mjs` | Cuts one packet's rules and spec sections into a small file. |
| `scripts/agents/queue-brief.mjs` | Queues every packet of a brief with its dependencies. |
| `scripts/agents/log-round.mjs` | Writes a packet's row and round entry in the build log; `--show` reads one row. |
| `scripts/agents/self-check.mjs` | Cheap check of edited files: conflict markers, focused tests, truncation. |
| `scripts/agents/clean-worktrees.sh` | Removes finished packet worktrees. Branches are kept. |
| `scripts/bin/check-lane.sh`, `ram-ok.sh` | Run one whole-repo job at a time; report memory pressure. |

The full reference is `scripts/hooks/README.md`. Document templates are in `docs/templates/`.

## Install

There are three ways. Pick one.

**a) Claude Code plugin.**

```
/plugin marketplace add ankeshshankar/agent-harness
/plugin install agent-harness@agent-harness
/agent-harness:init
```

The plugin gives you the roles, skills and the three default hooks. A plugin cannot write into your project, so `/agent-harness:init` lists the project files and, after you confirm, copies them in.

**b) Installer.** Run it in your project folder, or pass a folder.

```
npx github:ankeshshankar/agent-harness init
npx github:ankeshshankar/agent-harness init ../my-project --tools claude,cursor --prefix acme --with-hooks
npx github:ankeshshankar/agent-harness doctor
npx github:ankeshshankar/agent-harness update
```

`init` copies the project files, then runs the sync. It never overwrites an existing file unless you pass `--force`, and it lists what it skipped. `--dry-run` prints the plan and writes nothing. `--with-hooks` adds the default-on hooks to `.claude/settings.json` and keeps the hooks already there. `update` refreshes kit files you have not edited. It never touches `agents.config.json`, `AGENTS.md` or files you created.

**c) Template.** On GitHub, choose "Use this template" on this repository. You get a repository with everything already installed.

### Which one to use

| You use | Use |
| --- | --- |
| Claude Code on your machine, want updates through `/plugin` | (a) |
| Claude Code cloud sessions (claude.ai/code) | (b) or (c). Cloud sessions do not load plugins. They read the agents committed in the repository. |
| Cursor or Codex | (b) or (c). They read `.cursor/`, `.codex/` and `AGENTS.md` from the repository. |
| A team that wants every clone to have the agents | (b) or (c), then commit the files. |

## Configure

`agents.config.json` is the only file you edit to fit the kit to a project. `agents.config.schema.json` describes every key. `node bin/agent-harness.mjs doctor` (or `npx github:ankeshshankar/agent-harness doctor`) checks the file against it.

| Key | What it sets |
| --- | --- |
| `project.name` | The project name used in the generated files. |
| `rolePrefix` | Prefix for agent names, for example `acme-` gives `acme-builder`. |
| `packageManager` | `npm`, `pnpm`, `yarn`, `bun` or `none`. Used for installs in worktrees. |
| `defaultBranch` | Branch the guard protects. |
| `commands.lint`, `typecheck`, `test`, `verify` | Your real commands. `scripts/verify.mjs` runs them in this order. An empty one is skipped. |
| `paths.*` | Where specs, plans, research, handoff files, verification records, templates, rules and the state file live. |
| `models.<tool>` | Model tier map (`light`, `standard`, `reasoning`), per-role overrides and effort per tool. |
| `targets.<tool>` | Switch a target on or off, rename roles, change the output folder. |
| `harness.*` | Settings for the hooks and packet scripts: guard rules, size limits, queue, worktrees, headless command. All optional. See `scripts/hooks/README.md`. |

After you change a role, a skill or the config, run `node scripts/sync-agents.mjs`.

## Daily use

1. Set your real commands in `agents.config.json`, then run `node scripts/verify.mjs`.
2. Ask for a plan: `Use the planner to plan <your request>.`
3. Ask for a spec: `/spec-write <Feature>` (in the plugin: `/agent-harness:spec-write`). Read it, then change `status: draft` to `status: approved` yourself.
4. Build it: `/orchestrate <Feature>`. The orchestrator slices the spec into packets and runs each through build, check and review.
5. Run one packet headless: `scripts/agents/run-packet.sh docs/handoff/<feature>-build-brief.md P1 --dry-run` shows the command. Remove `--dry-run` to run it.
6. Read one packet's status without opening the whole log: `node scripts/agents/log-round.mjs --log docs/handoff/<feature>-build-log.md --show P1`.
7. Check the generated files are current: `node scripts/sync-agents.mjs --check`.
8. Before you say it is done: `node scripts/verify.mjs`.

In Codex, call skills with `$<name>` instead of `/<name>`.

## Memory

The kit has a plain-file convention for durable agent notes: one fact per file and an index with one line per file. It works in any tool. The `memory-init` skill explains it and creates the folder. The format is in `docs/memory-format.md`. A plugin cannot switch on a tool's own auto-memory; the convention is only files.

## Hooks

`guard-command`, `read-guard` and `context-guard` are on by default in the plugin and with `--with-hooks`. The others are off. To turn one off for a session, set its variable to `off`, for example `AGENT_HARNESS_GUARD=off`. To turn it off for good, delete its entry from the hooks file (`hooks/hooks.json` in the plugin, `.claude/settings.json` in a project). To turn an off-by-default hook on, copy its entry from `scripts/hooks/manifest.json`. Every hook allows the action if it crashes or gets bad input. State is kept in `.agent-harness/` in your project, which the installer adds to `.gitignore`.

## What was not tested

- No real headless run. `run-packet.sh` was tested only against a fake CLI. The `--effort` and `--permission-mode acceptEdits` flags were not checked against a real `claude` binary.
- No real worktree run with a package install.
- Linux paths in `scripts/hooks/lib/memory.mjs` and `scripts/agents/clean-worktrees.sh` were not run on Linux.
- The generated files were not loaded in a real Claude Code, Cursor or Codex session. Their formats follow each tool's documentation. The plugin passes `claude plugin validate`; it was not installed into a live session.
- The hooks were tested by piping sample JSON to them, not inside a running agent.
- Windows was not tried.

Tests cover the sync, the installer, the templates and the scripts: `npm test` (Node 20 and 24).

## Requirements

Node 20 or newer, git and bash. macOS and Linux paths are handled; only macOS has been run.

## Licence

MIT. See `LICENSE`. Copyright (c) 2026 Ankesh Kumar.
