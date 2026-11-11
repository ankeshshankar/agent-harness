import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseLine } from '../../scripts/hooks/packet-runner.mjs';
import { S, project, run } from './_helpers.mjs';

const HOOK = S('hooks', 'packet-runner.mjs');
// A fake run-packet.sh: fails when <project>/fail-<packet> exists, else prints a branch and RESULT PROCEED.
const FAKE = `#!/bin/bash
echo "ARGS $*"
if [ -f "$AGENT_HARNESS_ROOT/fail-$2" ]; then echo "RESULT BLOCKED"; exit 1; fi
echo "BRANCH packet/$2-1"
echo "RESULT PROCEED"
exit 0
`;

function setup(queue, cfg = {}) {
  const dir = project(cfg, { 'briefs/a-build-brief.md': '# brief\n', '.agent-harness/queue.txt': queue });
  const fake = join(dir, 'fake-runner.sh');
  writeFileSync(fake, FAKE);
  chmodSync(fake, 0o755);
  return { dir, env: { AGENT_HARNESS_TEST: '1', AGENT_HARNESS_RUNNER_CMD: fake } };
}
const hook = (s, extra = {}, args = [], event = { session_id: 's', source: 'startup' }) =>
  run(HOOK, args, { cwd: s.dir, input: JSON.stringify(event), env: { ...s.env, ...extra } });
const state = (dir) => {
  const p = join(dir, '.agent-harness', 'state', 'packets.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
};
const queue = (dir) => readFileSync(join(dir, '.agent-harness', 'queue.txt'), 'utf8');
const paused = (dir) => existsSync(join(dir, '.agent-harness', 'state', 'queue.paused'));
async function until(fn, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}
const settled = (dir, n) => () => state(dir).length >= n && state(dir).every((r) => r.status !== 'running') && !existsSync(join(dir, '.agent-harness', 'state', 'packets.lock'));
const B = 'briefs/a-build-brief.md';

test('parseLine: plain, with after, and bad lines', () => {
  assert.deepEqual(parseLine(`${B} P1`), { brief: B, packet: 'P1', after: [] });
  assert.deepEqual(parseLine(`${B} P2 after=P1,P0`).after, ['P1', 'P0']);
  assert.ok(parseLine(`${B} P2 later=P1`).bad);
  assert.ok(parseLine('only-one-word').bad);
  assert.ok(parseLine('/abs/brief.md P1').bad);
  assert.ok(parseLine('../x.md P1').bad);
  assert.ok(parseLine(`${B} bad/id`).bad);
});

test('chain on success: the first run starts, its end starts the next', async () => {
  const s = setup(`${B} P1\n${B} P2 after=P1\n`);
  const r = hook(s);
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /started/);
  await until(settled(s.dir, 2));
  const st = state(s.dir);
  assert.deepEqual(st.map((x) => [x.packet, x.status]), [['P1', 'done'], ['P2', 'done']]);
  assert.equal(queue(s.dir).trim(), '');
  assert.equal(paused(s.dir), false);
  // the dependent starts from the first packet's branch
  const log = readFileSync(st[1].logPath, 'utf8');
  assert.match(log, /--base packet\/P1-1/);
});

test('pause on failure: a failed run writes queue.paused and nothing else starts', async () => {
  const s = setup(`${B} P1\n${B} P3\n`);
  writeFileSync(join(s.dir, 'fail-P1'), '');
  hook(s);
  await until(() => paused(s.dir) && state(s.dir).every((r) => r.status !== 'running'));
  assert.equal(state(s.dir)[0].status, 'failed');
  assert.match(queue(s.dir), /P3/);
  // a new session reports the pause and still starts nothing
  const r = hook(s);
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.match(msg, /FAILED/);
  assert.match(msg, /paused/);
  assert.equal(state(s.dir).length, 1);
});

test('--resume clears the pause and starts the next packet', async () => {
  const s = setup(`${B} P1\n${B} P3\n`);
  writeFileSync(join(s.dir, 'fail-P1'), '');
  hook(s);
  await until(() => paused(s.dir) && state(s.dir).every((r) => r.status !== 'running'));
  const r = hook(s, {}, ['--resume']);
  assert.match(r.stdout, /resumed/);
  await until(settled(s.dir, 2));
  assert.equal(paused(s.dir), false);
  assert.equal(state(s.dir).find((x) => x.packet === 'P3').status, 'done');
});

test('a dependent of a failed packet stays queued; an independent one runs when pauseOnFailure is off', async () => {
  const s = setup(`${B} P1\n${B} P2 after=P1\n${B} P3\n`, { harness: { queue: { pauseOnFailure: false } } });
  writeFileSync(join(s.dir, 'fail-P1'), '');
  hook(s);
  await until(settled(s.dir, 2));
  const st = state(s.dir);
  assert.equal(st.find((x) => x.packet === 'P1').status, 'failed');
  assert.equal(st.find((x) => x.packet === 'P3').status, 'done');
  assert.equal(st.find((x) => x.packet === 'P2'), undefined);
  assert.match(queue(s.dir), /P2 after=P1/);
  assert.match(JSON.parse(hook(s).stdout).systemMessage, /waits: .*P2.*needs FAILED/);
});

test('--pause stops starting; --status is read-only', () => {
  const s = setup(`${B} P1\n`);
  assert.match(hook(s, {}, ['--pause', 'by hand']).stdout, /paused/);
  const r = hook(s);
  assert.equal(r.stdout.includes('started'), false);
  assert.equal(state(s.dir).length, 0);
  const st = hook(s, {}, ['--status']);
  assert.equal(st.status, 0);
  assert.equal(state(s.dir).length, 0);
});

test('a missing brief is recorded as failed, not started', () => {
  const s = setup('briefs/none-build-brief.md P1\n');
  hook(s);
  const msg = JSON.parse(hook(s).stdout).systemMessage;
  assert.match(msg, /FAILED/);
  assert.match(msg, /brief not found/);
});

test('no-ops: compact source, packet child, hook off', () => {
  const s = setup(`${B} P1\n`);
  assert.equal(hook(s, {}, [], { session_id: 's', source: 'compact' }).stdout.trim(), '');
  assert.equal(hook(s, { AGENT_HARNESS_PACKET_CHILD: '1' }).stdout.trim(), '');
  assert.equal(hook(s, { AGENT_HARNESS_QUEUE_HOOK: 'off' }).stdout.trim(), '');
  assert.equal(state(s.dir).length, 0);
  assert.match(queue(s.dir), /P1/);
});

test('an empty or missing queue is silent', () => {
  const dir = project();
  const r = run(HOOK, [], { cwd: dir, input: JSON.stringify({ source: 'startup' }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  mkdirSync(join(dir, '.agent-harness'), { recursive: true });
});
