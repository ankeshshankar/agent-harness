---
task: <short-name>
status: draft
author: planner
model: <the model this was produced with>
date: <YYYY-MM-DD>
---

# <Task>

## GOAL

What is true when this is done that is not true now.

## SCOPE

Numbered. Each item names the owning role and the artifact it produces.

| Item | User-facing? | Observability? | What to record | Flag? | Why |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## OUT OF SCOPE

What a reader would reasonably expect here and will not get, and why. An omission with no reason looks like an oversight.

## UNKNOWNS

Each is either a question for a human or a dispatch to the researcher. Never a guess. For every user-facing feature: "Ship behind a feature flag?" with a recommendation.

## GATES

Where a human approves, and what they approve. At minimum: the spec gate and the final check gate.

## VERIFICATION

How each scope item is proven done, and which can only ever be CANNOT-VERIFY for an agent.

## ITERATION BUDGET

Rounds of build and review before this escalates. Default 3. On exhaustion: what failed, what was tried, the best hypothesis, and the decision needed.
