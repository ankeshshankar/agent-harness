---
name: memory-init
description: "Explain and scaffold the memory convention, a folder of small files with one fact each, plus an index with one line per memory. Use when a project wants agents to keep durable notes about the user, feedback, the project and references."
---

<!-- generated from .agents/skills/memory-init/SKILL.md — do not edit. Edit the source, then run: node scripts/sync-agents.mjs -->

# memory-init

A plugin cannot switch on or configure automatic memory. What it can ship is a convention that any agent can follow by hand. This skill explains the convention and scaffolds it. The full one-page reference is `docs/memory-format.md`.

## The convention

- A memory folder holds one **index** file and many **memory** files.
- The index (`MEMORY.md`) has **one line per memory**: a link, a dash, and a short hook. It is loaded at the start of a session, so it stays short. Nothing but links lives in it.
- Each memory file holds **one fact**. If a note grows a second fact, split it.
- Each memory file starts with frontmatter: `name`, `description` (one line; used to decide relevance later), and `type`.
- `type` is one of four:
  - `user`: who the user is, their role, how they like to work.
  - `feedback`: a correction or a confirmed way of working, with the reason, so edge cases can be judged.
  - `project`: current goals, decisions and deadlines that are not in the code. Dates are written as absolute dates.
  - `reference`: where to find something outside the project (a dashboard, a tracker, a document).
- Never store what the code or git history already shows. Never store secrets, tokens or personal data.
- A wrong or stale memory is fixed or deleted, not appended to.

## Step 1 - Choose where it lives

Ask (numbered, recommendation first):

1. **Project memory** in the repository, for example `.agent-memory/` (commit it, or git-ignore it for private notes). Recommended for team conventions.
2. **Per-agent memory** using an agent's own `memory: project | user | local` setting, where the tool supports it.
3. **Docs only**: do not scaffold anything; the human follows `docs/memory-format.md` by hand.

## Step 2 - Scaffold (option 1)

Show the files first, write nothing that exists already, and never overwrite. Create:

`<folder>/MEMORY.md`:

```markdown
# Memory index

- [Prefers short answers](user-short-answers.md) - wants a 3-line summary before any detail
- [Run the full tests before a PR](feedback-full-tests-before-pr.md) - a skipped suite once hid a break
- [Checkout rewrite](project-checkout-rewrite.md) - goal and freeze date for the checkout work
- [Error dashboard](reference-error-dashboard.md) - where production errors are tracked
```

The four lines above are made-up examples. Delete them after the human has seen the shape, or keep them as the first notes if they apply.

One example memory file, `<folder>/feedback-full-tests-before-pr.md`:

```markdown
---
name: Run the full tests before a PR
description: Run the whole test suite, not just the changed files, before opening a pull request
type: feedback
---

Run the full test suite before opening a pull request.

**Why:** a change to a shared helper once passed its own tests and broke two other modules that only the full run covered.
**How to apply:** at the end of a feature, before any push or PR step. Narrow runs are fine while building.
```

## Step 3 - Tell the agents

Add one line to `AGENTS.md` under "Your project's rules": where the memory folder is, and that agents read `MEMORY.md` at the start and add or fix a memory when they learn a lasting fact.

## Reply

```
MEMORY: <folder> (index + <n> files)
TYPES: user, feedback, project, reference
NEXT: add a memory when a lasting fact comes up; keep MEMORY.md to one line per memory
```
