# Contributing

## Set up

Node 20 or newer, git and bash. There are no dependencies to install.

```bash
npm test               # all tests
npm run sync:check     # generated agent files are current
npm run build:plugin -- --check   # plugin folder is current
```

## Where to edit

- Roles, skills and method rules: `.agents/`. Never edit `.claude/`, `.cursor/`, `.codex/` or `plugins/agent-harness/agents|skills`. Edit the source, then run `node scripts/sync-agents.mjs`.
- Anything under `plugins/agent-harness/hooks`, `scripts`, `template` or `.claude-plugin`, and `.claude-plugin/marketplace.json`: edit the source file, then run `node scripts/build-plugin.mjs`.
- Hooks: `scripts/hooks/manifest.json` is the single list. Add a hook there, with its script and a test.
- Config keys: add the key to `agents.config.json` and `agents.config.schema.json` with a description, and to the table in `scripts/hooks/README.md`.

Commit the source and the generated files together. CI fails when they differ.

## Rules

- Zero npm dependencies. Plain `node:` modules and POSIX shell.
- No absolute paths, no user names, no secrets in any file.
- Every script works with no `agents.config.json` and fails open when it is a hook.
- Plain, exact English. Short sentences. Do not write a claim the tests do not back.
- Run `npm test` on Node 20 and on the current Node before a pull request.
