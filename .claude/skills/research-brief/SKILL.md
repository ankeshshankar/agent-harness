---
name: research-brief
description: "Write a dated, sourced research brief that answers an unknown about a library, platform behaviour, constraint or API that blocks a plan or spec."
---

<!-- generated from .agents/skills/research-brief/SKILL.md — do not edit. Edit the source, then run: node scripts/sync-agents.mjs -->

# research-brief

A brief exists so a decision is made once, by someone who checked, and the next person can see what was checked and when. Follow the steps in order.

## Never

- Install a package to try it. That changes the lock file and belongs to the dependency-manager.
- Report a version number from memory. Check it and cite where.
- Decide for the human. You recommend; they decide.

## Step 1 - Pin the question

Write the question in one sentence, precise enough that a reader can tell whether you answered it. Write what decision it unblocks.

## Step 2 - Read the project's real versions first

Read the manifests and configuration that fix versions (for example the package manifest and its lock file, runtime version files). A fact that is true in general but false under these versions is a false finding.

## Step 3 - Find sources, best first

1. Official documentation and changelogs for the version in use.
2. The library's source or release notes.
3. Issues, discussions, blog posts. Label each as **weaker evidence**.

For every claim, record the URL, the date you read it, and the version it applies to.

## Step 4 - Write `docs/research/<kebab-topic>.md`

Use `docs/templates/research-brief.md`:

```markdown
---
topic: <title>
author: researcher
model: <the model you are running as>
date: <today, YYYY-MM-DD>
---

## Question
## Answer (one paragraph, the recommendation first)
## Evidence (claim - source URL - date read - version)
## Under our versions (what changes for the versions in use)
## Options (each: what, cost, why it lost; the recommended one first)
## Cost of the recommendation (size, platform impact, maintenance, licence, how to reverse it)
## Could not verify (each item, and what would verify it)
```

"This is not possible under our constraints" is a complete and valuable answer.

## Step 5 - Check and reply

Run the project's format check on the file if one exists.

```
BRIEF: docs/research/<kebab-topic>.md
ANSWER: <one line>
RECOMMENDATION: <one line, with its cost>
COULD NOT VERIFY: <items> | none
```

A brief older than 90 days is re-verified, not reused.
