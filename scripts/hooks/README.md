# Hooks and scripts

Everything here is plain Node (20 or newer, no packages) or POSIX shell. Nothing writes outside the project. State goes to `.agent-harness/` (git-ignored); change it with `harness.stateDir` in `agents.config.json` or `AGENT_HARNESS_STATE`.

`manifest.json` is the one list of hooks. The plugin's `hooks/hooks.json` and the project-level wiring are generated from it. Each script has a header comment with its events, config keys, env vars and exit codes.

## How the project root is found

In order: `AGENT_HARNESS_ROOT`, `CLAUDE_PROJECT_DIR`, the nearest parent folder that has `agents.config.json` or `.git`, else the current folder. A missing `agents.config.json` is fine: every script has defaults.

## Hooks

| Id | Event, matcher | Default | What it does | Switch off |
| --- | --- | --- | --- | --- |
| `guard-command` | PreToolUse, Bash | on | Denies force push to the default branch, deleting it on the remote, publish and deploy commands, `rm -r` of the repo root, the working directory, its parent, home or `/`, and `reset --hard`, `clean -f`, `restore`, `checkout -f`, `stash drop` on a dirty tree. Asks for any other force push. Adds your own rules. | `AGENT_HARNESS_GUARD=off`, or `harness.guard.defaults: false` for the built-in rules only |
| `read-guard` | PreToolUse, Read | on | Blocks a whole read of a text file over 40 KB and says to search and read a line range. Ranged reads, images, PDF, notebooks, SVG and `SKILL.md` are exempt. | `AGENT_HARNESS_READ_GUARD=off` |
| `context-guard` | UserPromptSubmit | on | When the context passes 150,000 tokens, adds one reminder to save state before compaction. It repeats every further 100,000 tokens. | `AGENT_HARNESS_CONTEXT_GUARD=off` |
| `monitor-allow` | PreToolUse, Monitor | off | Auto-approves a Monitor watch when every part of its command only reads (tail, grep, ls, sleep, git status, and similar). Everything else keeps the normal prompt. | `AGENT_HARNESS_MONITOR_ALLOW=off` |
| `heavy-gate-pre`, `heavy-gate-post` | PreToolUse and PostToolUse, Bash | off | Makes whole-repo jobs (full verify, typecheck, a whole test run, native builds) take turns, and waits while memory pressure is high. It only delays; it never blocks and always exits 0. Skipped when `CI` is set. | `AGENT_HARNESS_HEAVY_GATE=off` |
| `packet-runner` | SessionStart | off | Starts queued packets, one detached headless session each, and reports finished runs. When one run ends it starts the next. A failed run pauses the queue. | `AGENT_HARNESS_QUEUE_HOOK=off` |

Blocking hooks exit 2 (stderr goes to the agent) or print a `permissionDecision`. The other hooks never block. Every hook fails open: a crash or bad input allows the action.

A hook is also switched off by removing its entry from the generated hooks file.

## Commands

Run by hand or by the agents. None needs a hook.

| Script | What it does |
| --- | --- |
| `scripts/agents/run-packet.sh <brief> <packet>` | Runs one packet in a fresh headless session. Refreshes the packet's slice first and refuses a spec that is not approved. `--worktree` runs it in its own git worktree; `--dry-run` prints the command and prompt. Exit 0 PROCEED, 1 ITERATE or BLOCKED, 2 error. |
| `scripts/agents/packet-slice.mjs --brief <brief> --packet <id>` | Cuts one packet's rules, risks, spec sections and report format into `<handoff>/<feature>/<id>.md`. `--check` fails on a missing or stale slice. A slice over the token budget fails ("packet too big, split it"). |
| `scripts/agents/log-round.mjs --log <file> --packet <id> --round <n> ...` | Updates the packet's row in the build log and appends a round entry. `--show <id>` prints the row and the log's tail, so the log is never read whole. |
| `scripts/agents/queue-brief.mjs <brief>` | Appends every packet of a brief to the queue with `after=` dependencies. Skips packets that are done or queued. Holds packets whose spec is not approved. `--dry-run` prints the plan. |
| `scripts/hooks/packet-runner.mjs --status`, `--pause`, `--resume` | Shows, pauses or resumes the queue. |
| `scripts/agents/self-check.mjs <files>` | Cheap mechanical check of edited files: conflict markers, focused tests, truncation markers (fail); skipped tests, TODO and FIXME (warn). Exit 1 on a fail. |
| `scripts/agents/clean-worktrees.sh` | Removes finished packet worktrees that are merged, clean, idle and older than an hour. Branches are kept. `--dry-run` shows what it would do. Always exits 0. |
| `scripts/agents/config-get.mjs <key> [default]` | Prints one `agents.config.json` value for shell scripts. |
| `scripts/hooks/status-delta.mjs <file>` | Prints only the table rows of a markdown status file that changed since the last call. `--key <name>` keeps separate snapshots; `--reset` clears one. |
| `scripts/bin/check-lane.sh <label> -- <command>` | Runs one whole-repo job when the lane is free (one at a time across sessions), logs its output, prints one summary line. Exit code is the command's. |
| `scripts/bin/ram-ok.sh` | Prints `OK pressure=<level> free=<n>%` or `WAIT ...`. Exit 1 only when pressure is critical. macOS and Linux. |

## Queue file

`.agent-harness/queue.txt`, one line per packet. `#` starts a comment.

```
docs/handoff/feature-build-brief.md P1
docs/handoff/feature-build-brief.md P2 after=P1
```

A line runs when every `after=` packet is done. A failed packet blocks its dependents. With `pauseOnFailure` (default on) a failure also writes `.agent-harness/state/queue.paused`, and nothing starts until `packet-runner.mjs --resume`. The branch of a finished dependency (the `BRANCH` line in its log) is passed to the next run as `--base` and `--merge`.

## Brief and log layout the scripts expect

- Brief file name: `<feature>-build-brief.md`, with frontmatter `spec: <path>`.
- Brief headings: `## HARD RULES`, `## RISK POINTS`, `## REPORT FORMAT`, `## PACKETS`. Under PACKETS, one `### <ID>. <title>` per packet with a `- **Spec:**` line and optionally `- **Name:**` and `Depends on:`.
- Slices: `<paths.handoff>/<feature>/<packet>.md`.
- Build log: `<feature>-build-log.md` next to the brief, with a `## Packets` table (first column is the packet id) and a `## Round journal`.

## Config keys

All under `harness` in `agents.config.json`, all optional. Top-level keys used: `defaultBranch`, `packageManager`, `rolePrefix`, `commands.verify|lint|typecheck|test`, `paths.handoff`, `paths.state`.

| Key | Default | Used by |
| --- | --- | --- |
| `harness.stateDir` | `.agent-harness` | all |
| `harness.queueFile` | `<stateDir>/queue.txt` | packet-runner, queue-brief |
| `harness.runPacket` | `scripts/agents/run-packet.sh` | packet-runner |
| `harness.headless.command` | `claude` | run-packet |
| `harness.headless.model`, `.effort`, `.args` | none | run-packet |
| `harness.worktree.dir` | `<stateDir>/worktrees` | run-packet |
| `harness.worktree.copy` | agent setup folders | run-packet, clean-worktrees |
| `harness.worktree.install` | from `packageManager` | run-packet |
| `harness.roles.builder`, `.reviewer` | from `rolePrefix` | run-packet |
| `harness.queue.maxConcurrent` | `1` (at most 4) | packet-runner |
| `harness.queue.pauseOnFailure` | `true` | packet-runner |
| `harness.guard.defaults` | `true` | guard-command |
| `harness.guard.deny`, `.ask` | none | guard-command (`"<regex>"` or `{"pattern","reason"}`) |
| `harness.guard.allow` | none | guard-command (regexes; checked first) |
| `harness.readGuard.maxBytes` | `40960` | read-guard |
| `harness.readGuard.allowExtensions`, `.allowPaths` | none | read-guard |
| `harness.contextGuard.tokens`, `.step`, `.message` | `150000`, `100000`, built-in (`{k}` is the size in thousands) | context-guard |
| `harness.heavy.lane`, `.narrow` | none | heavy-gate (extra regexes) |
| `harness.heavy.maxWaitSeconds`, `.criticalAloneSeconds` | `1200`, `300` | heavy-gate |
| `harness.monitorAllow.commands` | none | monitor-allow (extra read-only command names) |
| `harness.selfCheck.defaults` | `true` | self-check |
| `harness.selfCheck.rules` | none | self-check (`{id, pattern, level, message, extensions, raw}`) |
| `harness.selfCheck.format` | none | self-check (a command with `{files}`) |
| `harness.packetSlice.budgetTokens` | `12000` | packet-slice |
| `harness.buildLog.columns` | template names | log-round (for example `{"verdict": "Result"}`) |

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENT_HARNESS_ROOT`, `AGENT_HARNESS_STATE` | project root, state folder |
| `AGENT_HARNESS_GUARD`, `_READ_GUARD`, `_CONTEXT_GUARD`, `_MONITOR_ALLOW`, `_HEAVY_GATE`, `_QUEUE_HOOK` | `=off` disables that hook |
| `AGENT_HARNESS_READ_MAX_BYTES`, `_CONTEXT_TOKENS` | override the size and token limits |
| `AGENT_HARNESS_MAX_WAIT_S`, `_CRITICAL_ALONE_S`, `_POLL_MS` | heavy-gate waits |
| `AGENT_HARNESS_QUEUE`, `_QUEUE_MAX`, `_PAUSE_ON_FAILURE`, `_RUN_PACKET` | queue file, concurrency, pause on failure (`0` or `1`), runner path |
| `AGENT_HARNESS_HEADLESS_CMD`, `_DEFER_VERIFY` | headless command; `1` skips the full verify inside a packet |
| `AGENT_HARNESS_FORCE_PRESSURE` | `normal`, `warning` or `critical`; for tests |

## Tests

```
node --test "tests/scripts/*.test.mjs"
```

(Quote the glob. Newer Node versions do not accept a bare folder.)
