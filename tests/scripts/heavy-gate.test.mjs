import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../../scripts/hooks/heavy-gate.mjs';
import { S, project, run } from './_helpers.mjs';

const k = (c, cfg) => classify(c, cfg);

test('plain commands are not heavy', () => {
  for (const c of ['ls', 'git status', 'grep jest src', 'echo tsc', 'cat package.json']) assert.deepEqual(k(c), { heavy: false, lane: false }, c);
});
test('whole-repo builds are lane jobs', () => {
  for (const c of ['npx tsc --noEmit', 'tsc -p .', './gradlew build', 'xcodebuild -scheme x', 'cargo build', 'make verify', 'npm test', 'npx jest']) {
    assert.equal(k(c).lane, true, c);
  }
});
test('a test run with a file selector is narrow', () => {
  assert.deepEqual(k('npx jest src/a.test.ts'), { heavy: true, lane: false });
  assert.deepEqual(k('npx vitest run tests/a.test.ts'), { heavy: true, lane: false });
});
test('configured verify and typecheck commands are lane jobs', () => {
  const cfg = { commands: { verify: 'bash ci/check.sh', typecheck: 'mytc --all' } };
  assert.equal(k('bash ci/check.sh', cfg).lane, true);
  assert.equal(k('mytc --all --fast', cfg).lane, true);
  assert.equal(k('bash ci/other.sh', cfg).heavy, false);
});
test('config lane and narrow patterns', () => {
  const cfg = { harness: { heavy: { lane: ['^build-all\\b'], narrow: ['^quick-test\\b'] } } };
  assert.equal(k('build-all --x', cfg).lane, true);
  assert.deepEqual(k('quick-test tests/a.test.js', cfg), { heavy: true, lane: false });
});
test('a heavy part of a compound command counts', () => assert.equal(k('cd app && npx tsc --noEmit').lane, true));

const ev = (id, command) => JSON.stringify({ tool_use_id: id, tool_input: { command } });
const gate = (dir, mode, input, env = {}) => run(S('hooks', 'heavy-gate.mjs'), [mode], { cwd: dir, input, env: { AGENT_HARNESS_POLL_MS: '50', ...env } });
const jobs = (dir) => {
  const p = join(dir, '.agent-harness', 'lane', 'jobs');
  return existsSync(p) ? readdirSync(p) : [];
};

test('pre registers a lane job and post removes it; never blocks', () => {
  const dir = project();
  const a = gate(dir, 'pre', ev('t1', 'npx tsc --noEmit'), { AGENT_HARNESS_FORCE_PRESSURE: 'normal' });
  assert.equal(a.status, 0);
  assert.equal(a.stdout, '');
  assert.deepEqual(jobs(dir), ['t1.json']);
  assert.equal(gate(dir, 'post', ev('t1', 'npx tsc --noEmit')).status, 0);
  assert.deepEqual(jobs(dir), []);
});
test('a light command registers nothing', () => {
  const dir = project();
  gate(dir, 'pre', ev('t2', 'ls'));
  assert.deepEqual(jobs(dir), []);
});
test('a lane job under critical pressure times out and runs anyway (exit 0)', () => {
  const dir = project();
  const r = gate(dir, 'pre', ev('t3', 'npx tsc'), { AGENT_HARNESS_FORCE_PRESSURE: 'critical', AGENT_HARNESS_CRITICAL_ALONE_S: '1', AGENT_HARNESS_MAX_WAIT_S: '2' });
  assert.equal(r.status, 0);
  assert.deepEqual(jobs(dir), ['t3.json']);
});
test('off switch and CI skip the gate', () => {
  const dir = project();
  gate(dir, 'pre', ev('t4', 'npx tsc'), { AGENT_HARNESS_HEAVY_GATE: 'off' });
  gate(dir, 'pre', ev('t5', 'npx tsc'), { CI: 'true' });
  assert.deepEqual(jobs(dir), []);
});
