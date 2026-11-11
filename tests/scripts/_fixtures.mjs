// A small brief and spec used by the packet-slice, queue-brief and run-packet tests.
export const SPEC = (status = 'approved') => `---
status: ${status}
---
# Feat

## API

The API has one call.

### Errors

Errors are typed.

## DATA

Data is stored once.

## AMENDMENTS

A1. Changed later.
`;

export const BRIEF = `---
spec: docs/specs/Feat.md
---
# Build brief: Feat

## HARD RULES

- Never skip a test.

## RISK POINTS

| ID | Risk |
| --- | --- |
| RV-1 | The call can fail. |
| RV-2 | Data can be lost. |

## REPORT FORMAT

End with one RESULT line.

## PACKETS

### P1. First packet

- **Spec:** API
- **Name:** first
- Risk: RV-1

Build the API.

### P2. Second packet

- **Spec:** DATA
- **Name:** second
- Depends on: P1

Build the data layer.

### P3. Third packet

- **Spec:** API "Errors"
- Depends on: none

Build the errors.
`;

export const files = (status) => ({
  'docs/specs/Feat.md': SPEC(status),
  'docs/handoff/feat-build-brief.md': BRIEF,
});
