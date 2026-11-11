# Build log: <feature>

Save as `<handoff>/<feature>-build-log.md`, next to the build brief. `scripts/agents/log-round.mjs` updates the table and the journal below; do not rename the two headings or the first column. Delete this paragraph when you copy the file.

Spec: `<path>`. Brief: `<path>`. Started: <YYYY-MM-DD>.

One row per packet, updated every round by the orchestrator. `log-round.mjs` adds a row for a packet it does not find. The quality columns decide whether the builder or its model should change.

## Packets

| Packet | Name | Base | Builder | Round | Verdict | Findings | Hard-rule breaks | Scope | Honesty | Gate | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Round journal

Each entry is a `###` heading with the packet id, the round and the date in brackets, then bullets: what the builder claims, what the orchestrator checked (commands, exit codes, test summary line), the review verdict and finding ids, and the decision for the next round. `log-round.mjs` writes them.

## Switch rule

Two hard-rule breaks, or one report mismatch, across any two packets: pause and ask the human whether to change the builder's model.
