import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { S, project, run } from './_helpers.mjs';

const LOG = `# Build log: feat

## Packets

| Packet | Name | Round | Verdict | Findings | Scope | Honesty | Verify | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | first | 0 | | | | | | |

## Round journal

## Switch rule

Text.
`;
const setup = () => {
  const dir = project({}, { 'log.md': LOG });
  const f = join(dir, 'log.md');
  const go = (...a) => run(S('agents', 'log-round.mjs'), ['--log', f, ...a], { cwd: dir });
  return { dir, f, go };
};

test('updates an existing row and appends a journal entry', () => {
  const { f, go } = setup();
  const r = go('--packet', 'P1', '--round', '2', '--verdict', 'ITERATE', '--findings', '1 / 2 / 0', '--summary', 'Review: ITERATE', '--date', '2026-01-02');
  assert.equal(r.status, 0, r.stderr);
  const t = readFileSync(f, 'utf8');
  assert.match(t, /\| P1\s+\| first\s+\| 2\s+\| ITERATE\s+\| 1 \/ 2 \/ 0/);
  assert.match(t, /### P1, round 2 \(2026-01-02\)\n\n- Review: ITERATE\n/);
  assert.ok(t.indexOf('### P1, round 2') < t.indexOf('## Switch rule'));
});

test('adds a row for a new packet with dashes elsewhere', () => {
  const { f, go } = setup();
  assert.equal(go('--packet', 'P7', '--round', '1', '--verdict', 'PROCEED', '--no-journal').status, 0);
  assert.match(readFileSync(f, 'utf8'), /\| P7\s+\| —\s+\| 1\s+\| PROCEED/);
});

test('the same packet and round appends to the same section', () => {
  const { f, go } = setup();
  go('--packet', 'P1', '--round', '1', '--summary', 'one', '--date', '2026-01-02');
  go('--packet', 'P1', '--round', '1', '--summary', 'two', '--date', '2026-01-02');
  const t = readFileSync(f, 'utf8');
  assert.equal(t.match(/### P1, round 1/g).length, 1);
  assert.match(t, /- one[\s\S]*- two/);
});

test('--gate-log with --gate-exit fills the verify column', () => {
  const { dir, f, go } = setup();
  writeFileSync(join(dir, 'gate.log'), 'Tests: 12 passed, 12 total\n');
  assert.equal(go('--packet', 'P1', '--round', '1', '--gate-log', join(dir, 'gate.log'), '--gate-exit', '0').status, 0);
  const t = readFileSync(f, 'utf8');
  assert.match(t, /Full verify/);
  assert.match(t, /12 passed/);
});

test('--set writes any column by header; an unknown column is an error', () => {
  const { f, go } = setup();
  assert.equal(go('--packet', 'P1', '--set', 'Notes=hello', '--no-journal').status, 0);
  assert.match(readFileSync(f, 'utf8'), /hello/);
  assert.equal(go('--packet', 'P1', '--set', 'Nope=1', '--no-journal').status, 2);
});

test('--show prints the row and the tail', () => {
  const { go } = setup();
  go('--packet', 'P1', '--round', '1', '--verdict', 'PROCEED', '--no-journal');
  const r = go('--show', 'P1', '--tail', '3');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Verdict: PROCEED/);
  assert.match(r.stdout, /last 3 lines/);
});

test('bad input: missing log, missing packet, journal without round', () => {
  const { dir, go } = setup();
  assert.equal(run(S('agents', 'log-round.mjs'), ['--log', join(dir, 'none.md'), '--packet', 'P1', '--no-journal'], { cwd: dir }).status, 2);
  assert.equal(go('--round', '1').status, 2);
  assert.equal(go('--packet', 'P1').status, 2);
});

test('custom column names from config', () => {
  const dir = project({ harness: { buildLog: { columns: { verdict: 'Result' } } } }, { 'log.md': LOG.replace('Verdict', 'Result') });
  const f = join(dir, 'log.md');
  const r = run(S('agents', 'log-round.mjs'), ['--log', f, '--packet', 'P1', '--verdict', 'PROCEED', '--no-journal'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(f, 'utf8'), /PROCEED/);
});
