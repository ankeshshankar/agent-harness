import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { S, project, run } from './_helpers.mjs';
import { BRIEF, files } from './_fixtures.mjs';

const B = 'docs/handoff/feat-build-brief.md';
const qb = (dir, ...a) => run(S('agents', 'queue-brief.mjs'), [B, ...a], { cwd: dir });
const queue = (dir) => (existsSync(join(dir, '.agent-harness', 'queue.txt')) ? readFileSync(join(dir, '.agent-harness', 'queue.txt'), 'utf8') : '');

test('dry run prints the plan and writes nothing', () => {
  const dir = project({}, files());
  const r = qb(dir, '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/);
  assert.equal(queue(dir), '');
});

test('queues packets with the dependencies the brief declares', () => {
  const dir = project({}, files());
  assert.equal(qb(dir).status, 0);
  assert.equal(queue(dir), `${B} P1\n${B} P2 after=P1\n${B} P3\n`);
});

test('running twice does not duplicate', () => {
  const dir = project({}, files());
  qb(dir);
  const r = qb(dir);
  assert.match(r.stdout, /nothing to queue/);
  assert.equal(queue(dir).trim().split('\n').length, 3);
});

test('a brief with no declared dependencies becomes a serial chain', () => {
  const brief = BRIEF.replace(/- Depends on: .*\n/g, '');
  const dir = project({}, { ...files(), [B]: brief });
  qb(dir);
  assert.equal(queue(dir), `${B} P1\n${B} P2 after=P1\n${B} P3 after=P2\n`);
});

test('packets whose spec is not approved are held, with their dependents', () => {
  const dir = project({}, files('draft'));
  const r = qb(dir);
  assert.equal(r.status, 0);
  assert.equal(queue(dir), '');
  assert.match(r.stdout, /held/i);
});

test('a packet that is PROCEED in the build log is skipped', () => {
  const log = '# log\n\n## Packets\n\n| Packet | Name | Round | Verdict |\n| --- | --- | --- | --- |\n| P1 | first | 1 | PROCEED |\n';
  const dir = project({}, { ...files(), 'docs/handoff/feat-build-log.md': log });
  const r = qb(dir);
  assert.match(r.stdout, /done in build log: .*P1/);
  assert.equal(queue(dir), `${B} P2\n${B} P3\n`);
});

test('--include queues a held packet', () => {
  const log = '# log\n\n## Packets\n\n| Packet | Name | Round | Verdict |\n| --- | --- | --- | --- |\n| P3 | third | 1 | BLOCKED |\n';
  const dir = project({}, { ...files(), 'docs/handoff/feat-build-log.md': log });
  assert.doesNotMatch(queue(dir), /P3/);
  qb(dir);
  assert.doesNotMatch(queue(dir), /P3/);
  qb(dir, '--include', 'P3');
  assert.match(queue(dir), /P3/);
});

test('bad input: no brief, a brief outside the project, a missing brief', () => {
  const dir = project({}, files());
  assert.equal(run(S('agents', 'queue-brief.mjs'), [], { cwd: dir }).status, 1);
  writeFileSync(join(dir, 'x.md'), 'x');
  assert.notEqual(run(S('agents', 'queue-brief.mjs'), ['/etc/hosts'], { cwd: dir }).status, 0);
  assert.notEqual(run(S('agents', 'queue-brief.mjs'), ['docs/none-build-brief.md'], { cwd: dir }).status, 0);
});
