# Changelog

## 0.1.0

First release.

- Eight roles (planner, spec-writer, spec-reviewer, builder, code-reviewer, researcher, release-manager, dependency-manager) and nine skills, kept once in `.agents/` and generated for Claude Code, Cursor and Codex.
- `scripts/sync-agents.mjs` generates the agent files and `--check` detects drift. `scripts/verify.mjs` runs the commands set in `agents.config.json`.
- Packet scripts: `run-packet.sh`, `packet-slice.mjs`, `queue-brief.mjs`, `log-round.mjs`, `self-check.mjs`, `clean-worktrees.sh`.
- Hooks: `guard-command`, `read-guard` and `context-guard` on by default; `monitor-allow`, `heavy-gate` and `packet-runner` off by default.
- Claude Code plugin and marketplace (`/plugin marketplace add ankeshshankar/agent-harness`), built by `scripts/build-plugin.mjs`.
- Installer: `npx github:ankeshshankar/agent-harness init | update | doctor`.
- Document templates (spec, build brief, packet, build log, plan, handoff, research brief, state file) and a memory convention.
