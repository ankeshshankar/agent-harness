---
spec: docs/specs/<Feature>.md
---

# Build brief: <Feature>

Save as `<handoff>/<feature>-build-brief.md` (the file name must end in `-build-brief.md`; `<handoff>` is `paths.handoff`). `scripts/agents/packet-slice.mjs` cuts one small file per packet from this brief and the spec. It reads the four headings below by name, so keep them exactly. Delete these instruction lines when you copy the file.

## HARD RULES

Rules every packet must follow. They are copied into every slice, so keep them short and checkable.

- Do not edit a file that is not on the packet's create/edit list.
- Do not add a dependency, change a release setting or push. Stop and report instead.
- Every acceptance command must exit 0 before you report done.

## RISK POINTS

The places where a wrong build looks right. A packet names the ones it touches (for example `Risk: RV-1`); only those rows are copied into its slice.

| ID | Risk |
| --- | --- |
| RV-1 | <what can go wrong, and how the reviewer can tell> |

## REPORT FORMAT

What the builder's report must contain. It is copied into every slice. The orchestrator greps these sections, so keep the names.

```
FILES CHANGED: <paths>
TESTS ITEMS SATISFIED: <exact test names>
SELF-MUTATIONS: <only for [M] items: the change, the FAIL line, a clean cmp>
DEVIATIONS: <or None>
ADDED BEYOND SPEC: <or None>
CANNOT-VERIFY: <or None, with the reason>
RESULT <packet> DONE|BLOCKED
```

## PACKETS

One `### <ID>. <title>` per packet. Each needs a `- **Spec:**` line. `Name` is the plain-language label shown to people.

### P1. <short title>

- **Name:** <at most 6 words, what the user or operator gets>
- **Spec:** <section names by exact spec heading, for example INTERFACES; ERRORS; TESTS T1-T3>
- **Depends on:** none
- Risk: RV-1

Goal: <one sentence: what is true when this packet is done>

Create / edit: `<path>`, `<path>`

Do not touch: <paths or areas>

Acceptance: `<command>` exits 0; TESTS T1 `[M]`.

Stop and report if: the spec is not `approved`; a file outside the list must change; the spec and the code disagree.

### P2. <short title>

- **Name:** <...>
- **Spec:** <section names>
- **Depends on:** P1

Goal: <...>

Create / edit: `<path>`
