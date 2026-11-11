import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { delta, parse } from '../../scripts/hooks/status-delta.mjs';
import { S, project, run } from './_helpers.mjs';

const T1 = '| Task | State |\n| --- | --- |\n| a | running |\n| b | queued |\n';

test('parse: table rows keyed by first cell, other lines kept', () => {
  const p = parse(`hello\n${T1}`);
  assert.equal(p.tables.length, 1);
  assert.equal(p.tables[0].rows.get('a'), '| a | running |');
  assert.deepEqual(p.other, ['hello']);
});
test('delta: identical text is empty', () => assert.deepEqual(delta(T1, T1), []));
test('delta: a changed row is shown with its header', () => {
  const out = delta(T1, T1.replace('running', 'done'));
  assert.deepEqual(out, ['| Task | State |', '| a | done |']);
});
test('delta: new and removed rows', () => {
  const out = delta(T1, '| Task | State |\n| --- | --- |\n| a | running |\n| c | new |\n');
  assert.ok(out.includes('| c | new |'));
  assert.ok(out.includes('removed: b'));
});
test('delta: new free text lines are shown', () => {
  assert.deepEqual(delta('one\n', 'one\ntwo\n'), ['two']);
});

test('cli: first run prints everything, then only changes, then "no change"', () => {
  const dir = project();
  const f = join(dir, 'status.md');
  const go = (...a) => run(S('hooks', 'status-delta.mjs'), [f, ...a], { cwd: dir }).stdout;
  writeFileSync(f, T1);
  assert.equal(go(), T1);
  assert.match(go(), /^no change since \d\d:\d\d$/m);
  writeFileSync(f, T1.replace('queued', 'done'));
  assert.equal(go(), '| Task | State |\n| b | done |\n');
  assert.match(go('--reset'), /cleared/);
  assert.equal(go(), T1.replace('queued', 'done'));
});
test('cli: separate keys keep separate snapshots', () => {
  const dir = project();
  const f = join(dir, 'status.md');
  writeFileSync(f, T1);
  run(S('hooks', 'status-delta.mjs'), [f, '--key', 'one'], { cwd: dir });
  assert.equal(run(S('hooks', 'status-delta.mjs'), [f, '--key', 'two'], { cwd: dir }).stdout, T1);
});
