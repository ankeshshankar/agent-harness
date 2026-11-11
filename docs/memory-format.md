# Memory format

A convention for durable agent notes. It works in any tool because it is only files. Scaffold it with the `memory-init` skill.

## Layout

```
<memory folder>/
  MEMORY.md            the index: one line per memory
  user-<topic>.md      one fact each
  feedback-<topic>.md
  project-<topic>.md
  reference-<topic>.md
```

## The index

`MEMORY.md` holds links only, one line per memory: `- [Title](file.md) - short hook`. It is read at the start of a session, so keep each line under about 150 characters and the file short. No frontmatter, no prose.

```markdown
- [Prefers short answers](user-short-answers.md) - wants a 3-line summary before any detail
- [Run the full tests before a PR](feedback-full-tests-before-pr.md) - a skipped suite once hid a break
- [Checkout rewrite](project-checkout-rewrite.md) - goal and freeze date for the checkout work
- [Error dashboard](reference-error-dashboard.md) - where production errors are tracked
```

These examples are made up.

## A memory file

One fact per file. Frontmatter, then a short body.

```markdown
---
name: Run the full tests before a PR
description: Run the whole test suite, not just the changed files, before opening a pull request
type: feedback
---

Run the full test suite before opening a pull request.

**Why:** a change to a shared helper once passed its own tests and broke two modules only the full run covered.
**How to apply:** at the end of a feature, before any push or PR step.
```

| Field | Rule |
| --- | --- |
| `name` | short title |
| `description` | one line; decides whether the memory is relevant later, so make it specific |
| `type` | `user`, `feedback`, `project` or `reference` |

## The four types

| Type | Holds | Body shape |
| --- | --- | --- |
| `user` | who the user is, their role, how they like to work | the fact, and how it changes how you answer |
| `feedback` | a correction, or a way of working they confirmed | the rule, then **Why** and **How to apply** |
| `project` | goals, decisions, deadlines that are not in the code | the fact, **Why**, **How to apply**; dates as absolute dates |
| `reference` | where to find something outside the project | the pointer and what it is for |

## Rules

- Do not store what the code, the git history or `AGENTS.md` already shows.
- Do not store secrets, tokens, credentials or personal data.
- Convert relative dates ("next Thursday") to absolute dates when saving.
- Update or delete a memory that turns out wrong. Do not add a contradicting second one.
- Before acting on a memory that names a file, a command or a flag, check it still exists. A memory is a claim from the past.
- Keep one fact per file. When a note grows a second fact, split it and add a second index line.
