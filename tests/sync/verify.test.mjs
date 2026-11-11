import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'verify.mjs');

function run(commands, ...args) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-fixture-'));
  writeFileSync(join(dir, 'agents.config.json'), JSON.stringify({ project: { name: 'x' }, commands }));
  const r = spawnSync(process.execPath, [VERIFY, '--root', dir, ...args], { encoding: 'utf8' });
  return { ...r, dir };
}

const ok = 'node -e "process.exit(0)"';
const bad = 'node -e "console.error(\'boom\');process.exit(3)"';

test('all configured steps pass: one line per step and a final PASS', () => {
  const r = run({ lint: ok, typecheck: ok, test: ok, verify: ok });
  assert.equal(r.status, 0, r.stdout);
  assert.equal((r.stdout.match(/^PASS  /gm) || []).length, 4);
  assert.match(r.stdout, /\nPASS \(4 ran, 0 skipped\)/);
  assert.ok(existsSync(join(r.dir, '.agent-harness/logs/lint.log')));
});

test('steps run in order lint, typecheck, test, verify', () => {
  const r = run({ verify: ok, test: ok, typecheck: ok, lint: ok });
  const order = [...r.stdout.matchAll(/^PASS  (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['lint', 'typecheck', 'test', 'verify']);
});

test('a failing step gives FAIL, its exit code, its log tail, and a non-zero exit', () => {
  const r = run({ lint: ok, test: bad, verify: ok });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL  test +exit 3/m);
  assert.match(r.stdout, /\| boom/);
  assert.match(r.stdout, /\nFAIL \(test\)/);
  assert.match(readFileSync(join(r.dir, '.agent-harness/logs/test.log'), 'utf8'), /boom/);
  assert.match(r.stdout, /^PASS  verify/m); // later steps still run
});

test('--bail stops at the first failure', () => {
  const r = run({ lint: bad, test: ok }, '--bail');
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /^PASS  test/m);
});

test('unset commands are skipped and the output says so', () => {
  const r = run({ test: ok, lint: '' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^SKIP  lint +commands\.lint is not set/m);
  assert.match(r.stdout, /^SKIP  typecheck/m);
  assert.match(r.stdout, /^SKIP  verify/m);
  assert.match(r.stdout, /PASS \(1 ran, 3 skipped\)/);
});

test('nothing configured is a FAIL, not a pass', () => {
  const r = run({});
  assert.equal(r.status, 1);
  assert.match(r.stdout, /nothing was checked/);
});

test('missing config exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-empty-'));
  const r = spawnSync(process.execPath, [VERIFY, '--root', dir], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
