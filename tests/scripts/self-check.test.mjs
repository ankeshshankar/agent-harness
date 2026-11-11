import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkText, compileRules, strip } from '../../scripts/agents/self-check.mjs';
import { S, project, run } from './_helpers.mjs';

const rules = compileRules({});
const ids = (text, ext = '.js', r = rules) => checkText(text, ext, r).map((f) => `${f.level}:${f.id}`);

test('clean code has no findings', () => assert.deepEqual(ids('const a = 1;\nexport default a;\n'), []));
test('conflict markers fail', () => assert.ok(ids('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n').some((x) => x.startsWith('FAIL'))));
test('focused tests fail, skipped tests warn', () => {
  assert.ok(ids("it.only('x', () => {});").some((x) => x.startsWith('FAIL')));
  assert.ok(ids("it.skip('x', () => {});").some((x) => x.startsWith('WARN')));
});
test('TODO in code warns', () => assert.ok(ids('// TODO fix\nconst a = 1; // FIXME\n').some((x) => x.startsWith('WARN'))));
test('rules do not fire on text inside strings', () => {
  assert.deepEqual(ids("const s = 'it.only(x)';\n").filter((x) => x.startsWith('FAIL')), []);
});
test('block comments are not scanned as code', () => {
  assert.deepEqual(ids('/*\n it.only(\n*/\nconst a = 1;\n').filter((x) => x.startsWith('FAIL')), []);
});
test('config rules add to the defaults and defaults can be switched off', () => {
  const extra = compileRules({ harness: { selfCheck: { rules: [{ id: 'no-console', pattern: 'console\\.log', level: 'FAIL', message: 'no console' }] } } });
  assert.ok(ids('console.log(1)', '.js', extra).includes('FAIL:no-console'));
  const only = compileRules({ harness: { selfCheck: { defaults: false, rules: [{ id: 'x', pattern: 'xx' }] } } });
  assert.equal(only.length, 1);
});
test('a bad config pattern is skipped, not fatal', () => {
  assert.doesNotThrow(() => compileRules({ harness: { selfCheck: { rules: [{ id: 'bad', pattern: '(' }] } } }));
});
test('extensions limit a rule', () => {
  const r = compileRules({ harness: { selfCheck: { defaults: false, rules: [{ id: 'py', pattern: 'print\\(', extensions: ['.py'] }] } } });
  assert.deepEqual(ids('print(1)', '.js', r), []);
  assert.deepEqual(ids('print(1)', '.py', r), ['FAIL:py']);
});
test('strip blanks strings and line comments', () => assert.equal(strip("a('x') // c"), "a(' ') "));

test('cli: exit 1 on a FAIL finding, 0 when clean, 2 without files', () => {
  const dir = project();
  writeFileSync(join(dir, 'bad.js'), "it.only('x', () => {});\n");
  writeFileSync(join(dir, 'ok.js'), 'const a = 1;\n');
  assert.equal(run(S('agents', 'self-check.mjs'), ['bad.js'], { cwd: dir }).status, 1);
  assert.equal(run(S('agents', 'self-check.mjs'), ['ok.js'], { cwd: dir }).status, 0);
  assert.equal(run(S('agents', 'self-check.mjs'), [], { cwd: dir }).status, 2);
});
