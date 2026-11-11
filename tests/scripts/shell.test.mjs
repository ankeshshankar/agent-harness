import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, S, project, run } from './_helpers.mjs';
import { files } from './_fixtures.mjs';

const sh = (script, args, { cwd, env = {} } = {}) => {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('AGENT_HARNESS_') || k === 'CLAUDE_PROJECT_DIR') delete base[k];
  return spawnSync('bash', [script, ...args], { cwd, encoding: 'utf8', env: { ...base, AGENT_HARNESS_ROOT: cwd, ...env }, timeout: 30000 });
};

const SCRIPTS = ['agents/run-packet.sh', 'agents/clean-worktrees.sh', 'bin/check-lane.sh', 'bin/ram-ok.sh'];
for (const s of SCRIPTS) {
  test(`bash -n ${s}`, () => {
    const r = spawnSync('bash', ['-n', S(s)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
  test(`${s} has a header comment and is executable`, () => {
    const text = readFileSync(S(s), 'utf8').split('\n').slice(0, 4).join('\n');
    assert.match(text, /^#!/);
    assert.match(text, /scripts\//);
  });
}

test('every node script has a header comment naming its path', () => {
  for (const f of ['agents/config-get.mjs', 'agents/log-round.mjs', 'agents/packet-slice.mjs', 'agents/queue-brief.mjs', 'agents/self-check.mjs',
    'hooks/context-guard.mjs', 'hooks/guard-command.mjs', 'hooks/heavy-gate.mjs', 'hooks/monitor-allow.mjs', 'hooks/packet-runner.mjs', 'hooks/read-guard.mjs', 'hooks/status-delta.mjs']) {
    const head = readFileSync(S(f), 'utf8').split('\n').slice(0, 3).join('\n');
    assert.match(head, new RegExp(`scripts/${f.replace('.', '\\.')}`), f);
  }
});

test('ram-ok.sh: OK and exit 0 normally, WAIT and exit 1 when critical', () => {
  const dir = project();
  const ok = sh(S('bin/ram-ok.sh'), [], { cwd: dir, env: { AGENT_HARNESS_FORCE_PRESSURE: 'normal' } });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^OK pressure=normal/);
  const warn = sh(S('bin/ram-ok.sh'), [], { cwd: dir, env: { AGENT_HARNESS_FORCE_PRESSURE: 'warning' } });
  assert.equal(warn.status, 0);
  const bad = sh(S('bin/ram-ok.sh'), [], { cwd: dir, env: { AGENT_HARNESS_FORCE_PRESSURE: 'critical' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^WAIT pressure=critical/);
});

test('check-lane.sh: passes the exit code through and keeps a log', () => {
  const dir = project();
  const env = { AGENT_HARNESS_FORCE_PRESSURE: 'normal', AGENT_HARNESS_POLL_MS: '50' };
  const ok = sh(S('bin/check-lane.sh'), ['demo', '--', 'echo', 'hello'], { cwd: dir, env });
  assert.equal(ok.status, 0, ok.stderr);
  const runs = join(dir, '.agent-harness', 'lane', 'runs');
  assert.ok(existsSync(runs));
  assert.ok(readdirSync(runs).some((f) => readFileSync(join(runs, f), 'utf8').includes('hello')));
  const bad = sh(S('bin/check-lane.sh'), ['demo', '--', 'sh', '-c', 'echo oops; exit 3'], { cwd: dir, env });
  assert.equal(bad.status, 3);
  assert.match(bad.stdout + bad.stderr, /oops/);
  // The gate is skipped when CI is set, so the jobs folder may not exist there.
  const jobs = join(dir, '.agent-harness', 'lane', 'jobs');
  assert.equal(existsSync(jobs) ? readdirSync(jobs).length : 0, 0);
});

test('check-lane.sh: a usage error exits 2', () => {
  assert.equal(sh(S('bin/check-lane.sh'), [], { cwd: project() }).status, 2);
});

test('config-get.mjs reads dotted keys with a default', () => {
  const dir = project({ commands: { test: 'x' } });
  assert.equal(run(S('agents', 'config-get.mjs'), ['commands.test'], { cwd: dir }).stdout.trim(), 'x');
  assert.equal(run(S('agents', 'config-get.mjs'), ['commands.none', 'dflt'], { cwd: dir }).stdout.trim(), 'dflt');
});

function packetProject(status) {
  const dir = project({}, files(status));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const fake = join(dir, 'fakecli');
  writeFileSync(fake, '#!/bin/bash\necho "{\\"result\\": \\"done\\\\nRESULT P1 PROCEED rounds=1 report=x\\"}"\n');
  chmodSync(fake, 0o755);
  return { dir, fake };
}
const B = 'docs/handoff/feat-build-brief.md';

test('run-packet.sh --dry-run prints the command and the prompt, starts nothing', () => {
  const { dir } = packetProject('approved');
  const r = sh(S('agents/run-packet.sh'), [B, 'P1', '--dry-run'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude -p/);
  assert.match(r.stdout, /Packet: P1/);
  assert.equal(existsSync(join(dir, '.agent-harness', 'runs')), false);
});

test('run-packet.sh: a fake headless CLI runs, the RESULT line is passed on, exit 0', () => {
  const { dir, fake } = packetProject('approved');
  const r = sh(S('agents/run-packet.sh'), [B, 'P1'], { cwd: dir, env: { AGENT_HARNESS_HEADLESS_CMD: fake } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESULT P1 PROCEED rounds=1/);
  assert.ok(existsSync(join(dir, 'docs', 'handoff', 'feat', 'P1.md')));
});

test('run-packet.sh: a RESULT of BLOCKED exits 1', () => {
  const { dir, fake } = packetProject('approved');
  writeFileSync(fake, '#!/bin/bash\necho "{\\"result\\": \\"RESULT P1 BLOCKED rounds=1 report=x\\"}"\n');
  const r = sh(S('agents/run-packet.sh'), [B, 'P1'], { cwd: dir, env: { AGENT_HARNESS_HEADLESS_CMD: fake } });
  assert.equal(r.status, 1);
});

test('run-packet.sh refuses a draft spec and a missing agent CLI with exit 2', () => {
  const draft = packetProject('draft');
  const a = sh(S('agents/run-packet.sh'), [B, 'P1'], { cwd: draft.dir, env: { AGENT_HARNESS_HEADLESS_CMD: draft.fake } });
  assert.equal(a.status, 2);
  assert.match(a.stderr, /not approved/);
  const ok = packetProject('approved');
  const b = sh(S('agents/run-packet.sh'), [B, 'P1'], { cwd: ok.dir, env: { AGENT_HARNESS_HEADLESS_CMD: '/nonexistent-cli' } });
  assert.equal(b.status, 2);
  assert.match(b.stderr, /not available/);
  assert.equal(sh(S('agents/run-packet.sh'), [], { cwd: ok.dir }).status, 2);
});

test('clean-worktrees.sh --dry-run in a repo with no packet worktrees exits 0', () => {
  const dir = project();
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = sh(S('agents/clean-worktrees.sh'), ['--dry-run'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /removed=0/);
});

test('clean-worktrees.sh outside a repo still exits 0', () => {
  assert.equal(sh(S('agents/clean-worktrees.sh'), ['--quiet'], { cwd: project() }).status, 0);
});

test('manifest.json is valid and every hook script exists', () => {
  const m = JSON.parse(readFileSync(S('hooks/manifest.json'), 'utf8'));
  const hooks = m.hooks ?? m;
  assert.ok(hooks.length >= 5);
  for (const h of hooks) {
    for (const k of ['id', 'event', 'script', 'timeout', 'blocking', 'default', 'description']) assert.ok(k in h, `${h.id} lacks ${k}`);
    assert.ok(existsSync(join(REPO, h.script)) || existsSync(S('hooks', h.script)) || existsSync(S(h.script)), `${h.id}: ${h.script}`);
  }
});
