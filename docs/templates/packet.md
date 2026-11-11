---
packet: <P1>
feature: <feature>
spec_status: approved
---

# <P1> - <short title>

> Manual fallback. With `scripts/agents/packet-slice.mjs` installed, the slice is cut from the build brief (`docs/templates/build-brief.md`) and you do not write this file. Without it, write one packet file by hand in this shape.

- **Name:** <at most 6 words, plain language: what the user or operator gets>
- **Spec:** <section names by exact heading, e.g. INTERFACES; ERRORS; TESTS T3-T5>
- **Depends on:** none
- **Goal:** <one sentence: what is true when this packet is done>

## Read first

Exact sections of the spec and exact files. Nothing else.

- ...

## Create / edit

- `<path>`
- `<path>`

Files: `<path>`, `<path>`

## Do not touch

- ...

## Acceptance

Exact commands, and the TESTS items this packet must satisfy. Mark the 1 to 3 riskiest `[M]`.

- `<command>` exits 0
- TESTS 1: <behaviour>
- TESTS 2: <behaviour> `[M]`

## Stop and report if

- the spec is not `approved`
- a file outside the create/edit list must change
- a dependency, a release setting or a missing shared component is needed
- the spec and the code disagree

## Prompt (copy and paste)

```
You are the builder. Read only docs/handoff/<feature>/<P1>.md, not the spec or the build brief.
Follow the new-feature skill. Report: <scratch>/<P1>-r1-builder.md
```
