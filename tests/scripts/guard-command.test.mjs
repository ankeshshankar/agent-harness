import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { decide } from '../../scripts/hooks/guard-command.mjs';
import { S, project, run } from './_helpers.mjs';

const ctx = (extra = {}) => ({ cfg: {}, root: '/work/proj', cwd: '/work/proj', home: '/home/u', defaultBranch: 'main', dirty: () => false, ...extra });
const d = (cmd, extra) => decide(cmd, ctx(extra)).decision;

const DENY = [
  'git push --force origin main',
  'git push -f origin main',
  'git push origin +main',
  'git push --force-with-lease origin main',
  'git push origin :main',
  'npm publish',
  'pnpm publish --access public',
  'cargo publish',
  'terraform apply',
  'firebase deploy',
  'gh release create v1',
  'kubectl apply -f x.yaml',
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /home/u',
  'rm -rf .',
  'rm -rf /work/proj',
  'rm -rf ..',
];
const ALLOW = [
  'ls -la',
  'git status',
  'git push origin feature/x',
  'rm -rf node_modules',
  'rm -rf dist build',
  "echo 'npm publish'",
  'grep -r "terraform apply" docs',
  'npm test',
  'git commit -m "fix: publish step"',
];
for (const c of DENY) test(`deny: ${c}`, () => assert.equal(d(c), 'deny'));
for (const c of ALLOW) test(`allow: ${c}`, () => assert.equal(d(c), 'allow'));

test('force push to another branch asks', () => {
  assert.equal(d('git push --force origin feature/x'), 'ask');
  assert.equal(d('git push --force-with-lease origin feature/x'), 'ask');
});

test('a custom default branch is protected', () => {
  assert.equal(d('git push -f origin trunk', { defaultBranch: 'trunk' }), 'deny');
  assert.notEqual(d('git push -f origin main', { defaultBranch: 'trunk' }), 'deny');
});

test('destructive git on a dirty tree is denied, on a clean tree allowed, unknown asks', () => {
  assert.equal(d('git reset --hard HEAD~1', { dirty: () => true }), 'deny');
  assert.equal(d('git clean -fd', { dirty: () => true }), 'deny');
  assert.equal(d('git reset --hard', { dirty: () => false }), 'allow');
  assert.equal(d('git reset --hard', { dirty: () => null }), 'ask');
});

test('config deny, ask and allow rules', () => {
  const cfg = { harness: { guard: { deny: [{ pattern: '\\bdrop table\\b', reason: 'no drops' }], ask: ['\\bmigrate\\b'], allow: ['^npm publish --dry-run'] } } };
  assert.equal(decide('psql drop table x', ctx({ cfg })).reason, 'no drops');
  assert.equal(d('npm run migrate', { cfg }), 'ask');
  assert.equal(d('npm publish --dry-run', { cfg }), 'allow');
});

test('defaults can be switched off', () => {
  assert.equal(d('npm publish', { cfg: { harness: { guard: { defaults: false } } } }), 'allow');
});

test('AGENT_HARNESS_GUARD=off allows everything', () => {
  const old = process.env.AGENT_HARNESS_GUARD;
  process.env.AGENT_HARNESS_GUARD = 'off';
  try {
    assert.equal(d('npm publish'), 'allow');
  } finally {
    if (old === undefined) delete process.env.AGENT_HARNESS_GUARD;
    else process.env.AGENT_HARNESS_GUARD = old;
  }
});

test('hook mode: claude format prints a deny decision, allow prints nothing', () => {
  const dir = project();
  const input = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir });
  const bad = run(S('hooks', 'guard-command.mjs'), ['--format', 'claude'], { cwd: dir, input: input('npm publish') });
  assert.equal(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = run(S('hooks', 'guard-command.mjs'), ['--format', 'claude'], { cwd: dir, input: input('ls') });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), {});
});

test('dirty tree is read from a real git repo', () => {
  const dir = project();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const r = run(S('hooks', 'guard-command.mjs'), ['--check', 'git reset --hard'], { cwd: dir });
  assert.match(r.stdout + r.stderr, /deny/i);
});
