// The shipped templates must work with the scripts that read them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = (name) => readFileSync(join(REPO, 'docs', 'templates', name), 'utf8');

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-tpl-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'agents.config.json'), JSON.stringify({ project: { name: 't' } }));
  return dir;
}
function node(dir, script, args) {
  const env = { ...process.env, AGENT_HARNESS_ROOT: dir };
  for (const k of Object.keys(env)) if (k === 'CLAUDE_PROJECT_DIR' || k === 'CI') delete env[k];
  return spawnSync(process.execPath, [join(REPO, 'scripts', ...script), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 20000 });
}
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

test('packet-slice cuts a packet from the shipped brief and spec templates', () => {
  const dir = project();
  const brief = T('build-brief.md')
    .replace('docs/specs/<Feature>.md', 'docs/specs/Feat.md')
    .replace(/^- \*\*Spec:\*\* <.*$/gm, '- **Spec:** SCOPE; INTERFACES');
  write(dir, 'docs/handoff/feat-build-brief.md', brief);
  write(dir, 'docs/specs/Feat.md', T('spec.md').replace('status: draft', 'status: approved'));
  const r = node(dir, ['agents', 'packet-slice.mjs'], ['--brief', 'docs/handoff/feat-build-brief.md', '--packet', 'P1']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const slice = readFileSync(join(dir, 'docs/handoff/feat/P1.md'), 'utf8');
  assert.match(slice, /spec_status: approved/);
  assert.match(slice, /## HARD RULES/);
  assert.match(slice, /RV-1/);
  assert.match(slice, /## REPORT FORMAT/);
  assert.match(slice, /## SCOPE/);
  assert.match(slice, /## INTERFACES/);
  assert.match(slice, /## AMENDMENTS/);
  assert.doesNotMatch(slice, /## HUMAN CHECKLIST/);
  const check = node(dir, ['agents', 'packet-slice.mjs'], ['--brief', 'docs/handoff/feat-build-brief.md', '--packet', 'P1', '--check']);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  const p2 = node(dir, ['agents', 'packet-slice.mjs'], ['--brief', 'docs/handoff/feat-build-brief.md', '--packet', 'P2']);
  assert.equal(p2.status, 0, p2.stderr + p2.stdout);
});

test('the spec template has every heading the slicer and reviewers rely on', () => {
  const spec = T('spec.md');
  for (const h of ['SCOPE', 'INTERFACES', 'ERRORS', 'TESTS', 'OPEN QUESTIONS', 'AMENDMENTS']) {
    assert.match(spec, new RegExp(`^## ${h}\\b`, 'm'), h);
  }
});

test('log-round writes a round into the shipped build-log template', () => {
  const dir = project();
  write(dir, 'docs/handoff/feat-build-log.md', T('build-log.md'));
  const log = join(dir, 'docs/handoff/feat-build-log.md');
  const go = (...a) => node(dir, ['agents', 'log-round.mjs'], ['--log', log, ...a]);
  const r = go(
    '--packet', 'P1', '--round', '1', '--verdict', 'PROCEED', '--findings', '0 / 0 / 0', '--scope', 'clean',
    '--honest', 'clean', '--gate', 'deferred', '--base', 'abc1234', '--builder', 'builder', '--hard-rule', 'none',
    '--notes', 'ok', '--set', 'Name=first', '--summary', 'Review: PROCEED', '--date', '2026-01-02',
  );
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(log, 'utf8');
  assert.match(text, /\| P1\s+\| first\s+\| abc1234\s+\| builder\s+\| 1\s+\| PROCEED\s+\| 0 \/ 0 \/ 0\s+\| none\s+\| clean\s+\| clean\s+\| deferred\s+\| ok\s+\|/);
  assert.match(text, /### P1, round 1 \(2026-01-02\)\n\n- Review: PROCEED\n/);
  assert.ok(text.indexOf('### P1, round 1') < text.indexOf('## Switch rule'));
  const show = go('--show', 'P1');
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /Verdict: PROCEED/);
  assert.equal(go('--packet', 'P1', '--round', '2', '--verdict', 'ITERATE', '--summary', 'again').status, 0);
  assert.match(readFileSync(log, 'utf8'), /### P1, round 2/);
});
