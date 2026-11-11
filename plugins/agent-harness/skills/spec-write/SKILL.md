---
name: spec-write
description: "Write or revise a feature spec, the contract that gates implementation. Use when designing a new feature, flow, module or interface change before any code, or when an existing spec needs an amendment."
---

<!-- generated from .agents/skills/spec-write/SKILL.md — do not edit. Edit the source, then run: node scripts/sync-agents.mjs -->

# spec-write

The spec is the deliverable. The builder will not start without one marked `status: approved` by a human, so every gap you leave stops the build. Follow the steps in order.

## Step 0 - Stop conditions

Stop and report if:

- A contract this feature depends on does not exist and nobody has designed it. Write the spec up to **INTERFACES**, mark it blocked in OPEN QUESTIONS, and stop. A spec built on an imagined contract is worse than none.
- The design reference or the product decision behind the feature is missing.

You never write implementation code, and you never set `status: approved`.

## Step 1 - Read

1. `AGENTS.md` and the rules in `docs/rules/` that apply.
2. The most recent approved spec of the same kind in `docs/specs/`. Match its decisions unless you state a reason not to.
3. `docs/templates/spec.md`.

## Step 2 - Create the file

Copy the template to `docs/specs/<Feature>.md` (PascalCase). Fill the frontmatter:

```yaml
feature: <Name>
status: draft
author: spec-writer
model: <the model you are running as>
date: <today, YYYY-MM-DD>
```

Keep every heading. A section that does not apply says `None.` and why.

## Step 3 - Fill each section; each has a test of done

| Section | Done when |
| --- | --- |
| SCOPE | In-scope and out-of-scope lists; each out-of-scope item says where it goes instead. |
| BEHAVIOUR | Every flow and every state is named: loading, empty, error, offline, no permission, success. |
| INTERFACES | Per interface: name, request, response example and every error code. Real, not hoped. |
| DATA AND STATE | A schema per request and response; which fields are optional and why; who owns each piece of state and why. |
| ERRORS | A table: every error kind by (first load, background refresh) giving what the user sees. Cancelled is listed. Failure never looks like empty. |
| WRITES AND SAFETY | Per mutation: idempotency stance, retry stance, ordering, and what a timeout shows. |
| SECURITY AND PRIVACY | What is sensitive, and where it must never appear (logs, keys, URLs, events, snapshots). |
| PERFORMANCE AND LIMITS | Numbers with units: list size, payload size, render budget, poll interval. |
| DEPENDENCIES AND PLATFORM IMPACT | `None.`, or the dependency, why, and its effect on release and rollback. |
| ROLLOUT | **Ask the human** (Step 4). Until answered: your recommendation plus an OPEN QUESTION. Once answered: key, type, default, off-state, gate location, removal plan. |
| OBSERVABILITY | Every interaction and outcome has a signal with a name, properties (enumerations, booleans, bounded integers only) and the place it fires. An exemption needs a one-line reason. |
| TESTS | A numbered list. Each item is one observable behaviour a test will assert. Mark the 1 to 3 riskiest `[M]`. |
| HUMAN CHECKLIST | Checkboxes a human can tick in the real environment, each with the expected value. |
| OPEN QUESTIONS | Every guess, with what would confirm it. |

## Step 4 - Ask the human, all at once

Collect every decision only a human can make (flag or no flag, a product choice, a contract change) and ask them as numbered questions, each with 2 to 4 options and your recommendation marked. Record the answers in the spec; keep any unanswered one in OPEN QUESTIONS.

## Step 5 - Check

Run the project's docs or format check on the file if one exists. Then re-read the spec once against this list and fix anything that fails:

- [ ] Every user-visible string is written out.
- [ ] No signal property carries personal data, an id, a URL or free text.
- [ ] Every mutation has idempotency, retry and ordering.
- [ ] Every section from the template is present.
- [ ] `status: draft`.

## Step 6 - Reply

```
SPEC: docs/specs/<Feature>.md (status: draft)
CHECKS: <command> -> exit <code>, last lines of output
DECISIONS NEEDED: <numbered questions with options and your recommendation> | none
UPSTREAM REQUESTS FILED: <paths> | none
OPEN QUESTIONS: <count, and the ones that block the build>
NEXT: spec review (spec-reviewer: clarity, fit, plan) before approval
```

When review findings come back, fix every BLOCKING one, take SHOULD-FIX where it helps, and list each finding with the change you made or why you declined it.
