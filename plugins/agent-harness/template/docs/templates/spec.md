---
feature: <Name>
status: draft
author: spec-writer
model: <the model this was produced with>
date: <YYYY-MM-DD>
---

# <Name>

> `status` starts at `draft`. Only a human sets `approved`, and that edit is the review record. The builder refuses to start without it. Every section below is required: write "None." and why rather than deleting a heading.

## SCOPE

In scope:

- ...

Out of scope (and where each item goes instead):

- ...

## BEHAVIOUR

Every flow, screen or command, and every state of each: loading, empty, error, offline, no permission, success.

## INTERFACES

Every endpoint, function, command or message: request, response, error responses.

If a contract this feature depends on does not exist yet, stop here and say so. A spec built on an imagined contract is worse than none.

## DATA AND STATE

Schemas and where each is validated. Which state is owned by whom. What, if anything, justifies a new store. The default is no new store.

## ERRORS

| Error kind | First load | Background refresh |
| --- | --- | --- |
| cancelled | | |
| network or timeout | | |
| unauthenticated | | |
| forbidden | | |
| invalid input | | |
| conflict | | |
| rate limited | | |
| server | | |
| unexpected response shape | | |

A failed first load, a failed refresh, an empty result and a cancelled request are four different states.

## WRITES AND SAFETY

Per mutation: idempotency stance, retry stance, ordering, and what a timeout means. A write with no idempotency stance is an incomplete spec.

## SECURITY AND PRIVACY

What is sensitive, where it is stored, what must never be logged, what the server must re-verify.

## PERFORMANCE AND LIMITS

Numbers with units: sizes, counts, budgets, intervals.

## DEPENDENCIES AND PLATFORM IMPACT

New dependencies, platform-specific pieces, and their effect on release and rollback. Usually "None."

## ROLLOUT

**A human decision. Ask it, never assume it.** Does this ship behind a feature flag?

- **Answer:** yes / no, decided by `<name>` on `<YYYY-MM-DD>` (until answered, this is an open question and the spec cannot be approved).
- **If yes:** flag key, type, default before load, what the user sees when it is off, where the gate sits, the removal plan.
- **If no:** why not.

## OBSERVABILITY

Signals are built with the feature, never added afterwards. For a user-facing feature, walk every screen or command, list every interaction and every outcome, and map each to a signal. The only exemption is an item listed here with a one-line reason.

| Signal (`<feature>_<object>_<action>`, past tense) | Fired when | Properties (enumeration, boolean or bounded integer) | Fired from |
| --- | --- | --- | --- |
| | | | |

Never sent: personal data, free text, ids, URLs, error messages.

## TESTS

The behaviours that must be asserted, named as behaviours, not files. Mark the 1 to 3 riskiest `[M]`.

1. ...
2. ... `[M]`

## HUMAN CHECKLIST

What a human must verify in the real environment. Each item has the expected value.

- [ ] ...

## OPEN QUESTIONS

Every guess, with what would confirm it. The rollout question lives here until answered.

1. ...

## AMENDMENTS

None yet. Append each change made after approval as `A1.`, `A2.` ... with the date, what changed and why. The packet slicer copies this section into every packet.
