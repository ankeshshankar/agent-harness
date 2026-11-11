---
name: upstream-request
description: "File a gap in a dependency your team owns but does not edit from this project (a missing shared component, variant, option or design token) as a request file, then stop. Use the moment a feature needs something the upstream package does not provide."
---

<!-- generated from .agents/skills/upstream-request/SKILL.md — do not edit. Edit the source, then run: node scripts/sync-agents.mjs -->

# upstream-request

An upstream package is a separate repository or published package that this project consumes and does not edit. A design system or shared library is the usual case. Follow the steps in order.

## Step 1 - Prove it is really missing

Check the **installed** package, not your memory of it: list its exports, search its type definitions or token files for the name. If it exists, use it and stop here.

## Step 2 - Try the legal moves, in order

1. **Compose it** from what the package already provides. If that works, do it and stop.
2. **Project-local code**: only if it encodes knowledge specific to this project that the upstream should never carry. Rare.
3. **File the request** (Step 3) and stop.

There is no fourth move. Never re-implement an upstream component locally, never inline a value that should be a token, and never edit the package in `node_modules` or in its repository.

## Step 3 - Write `docs/upstream-requests/<Component>.md`

If the file already exists, add your need to it instead of creating a second one.

```markdown
---
component: <Name>
status: draft
author: <your role>
model: <the model you are running as>
date: <today, YYYY-MM-DD>
---

## What is needed

## Where it is needed (feature, screen, spec section, design reference)

## What exists today (and why it does not cover this)

## Proposed shape (props, variants, states; the upstream decides the final API)

## Blocking? (is the feature stopped, or is there an interim composition?)
```

Use the upstream's own vocabulary and naming rules, not your project's.

## Step 4 - Stop and reply

```
UPSTREAM REQUEST: docs/upstream-requests/<Component>.md
BLOCKS: <what cannot proceed>
INTERIM: <composition used, approved by the human> | none - stopped
```

Do not continue with a workaround unless the human tells you to. If they do, record the workaround in the request and note that it must be removed when the upstream ships the missing piece.
