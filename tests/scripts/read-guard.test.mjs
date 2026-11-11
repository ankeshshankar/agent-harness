import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from '../../scripts/hooks/read-guard.mjs';
import { S, project, run } from './_helpers.mjs';

const dir = project();
const big = join(dir, 'big.txt');
const small = join(dir, 'small.txt');
writeFileSync(big, 'x'.repeat(50 * 1024));
writeFileSync(small, 'hello');
const rg = (tool_input, cfg = {}) => decide({ tool_name: 'Read', tool_input }, cfg).block;

test('a whole read of a big file is blocked', () => assert.equal(rg({ file_path: big }), true));
test('a small file is allowed', () => assert.equal(rg({ file_path: small }), false));
test('a ranged read of a big file is allowed', () => {
  assert.equal(rg({ file_path: big, offset: 10, limit: 50 }), false);
  assert.equal(rg({ file_path: big, limit: 50 }), false);
});
test('a missing file is allowed (the Read tool reports it)', () => assert.equal(rg({ file_path: join(dir, 'nope.txt') }), false));
test('images, pdf and SKILL.md are exempt', () => {
  for (const n of ['a.png', 'a.pdf', 'a.ipynb']) {
    writeFileSync(join(dir, n), 'x'.repeat(50 * 1024));
    assert.equal(rg({ file_path: join(dir, n) }), false, n);
  }
  mkdirSync(join(dir, 's'));
  writeFileSync(join(dir, 's', 'SKILL.md'), 'x'.repeat(50 * 1024));
  assert.equal(rg({ file_path: join(dir, 's', 'SKILL.md') }), false);
});
test('config: maxBytes, allowExtensions and allowPaths', () => {
  assert.equal(rg({ file_path: small }, { harness: { readGuard: { maxBytes: 2 } } }), true);
  assert.equal(rg({ file_path: big }, { harness: { readGuard: { maxBytes: 100000 } } }), false);
  assert.equal(rg({ file_path: big }, { harness: { readGuard: { allowExtensions: ['.txt'] } } }), false);
  assert.equal(rg({ file_path: big }, { harness: { readGuard: { allowPaths: ['big\\.txt$'] } } }), false);
});
test('hook mode exits 2 with a reason on stderr for a blocked read', () => {
  const r = run(S('hooks', 'read-guard.mjs'), [], { cwd: dir, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: big } }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /offset|limit|range/i);
  const ok = run(S('hooks', 'read-guard.mjs'), [], { cwd: dir, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: small } }) });
  assert.equal(ok.status, 0);
});
test('AGENT_HARNESS_READ_GUARD=off disables it', () => {
  const r = run(S('hooks', 'read-guard.mjs'), [], { cwd: dir, env: { AGENT_HARNESS_READ_GUARD: 'off' }, input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: big } }) });
  assert.equal(r.status, 0);
});
