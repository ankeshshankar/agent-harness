import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { S, project, run } from './_helpers.mjs';
import { files, SPEC } from './_fixtures.mjs';

const BRIEF = 'docs/handoff/feat-build-brief.md';
const slice = (dir, ...a) => run(S('agents', 'packet-slice.mjs'), ['--brief', BRIEF, ...a], { cwd: dir });
const out = (dir, id) => join(dir, 'docs', 'handoff', 'feat', `${id}.md`);

test('generates one slice with rules, the packet, the spec sections and amendments', () => {
  const dir = project({}, files());
  const r = slice(dir, '--packet', 'P1');
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(out(dir, 'P1'), 'utf8');
  assert.match(text, /spec_status: approved/);
  assert.match(text, /Never skip a test/);
  assert.match(text, /RV-1/);
  assert.doesNotMatch(text, /RV-2/);
  assert.match(text, /The API has one call/);
  assert.doesNotMatch(text, /Data is stored once/);
  assert.match(text, /Changed later/);
  assert.match(text, /End with one RESULT line/);
  assert.match(text, /Build the API/);
  assert.doesNotMatch(text, /Build the data layer/);
});

test('--all writes every packet; a quoted sub-heading resolves to that H3', () => {
  const dir = project({}, files());
  assert.equal(slice(dir, '--all').status, 0);
  for (const id of ['P1', 'P2', 'P3']) assert.ok(existsSync(out(dir, id)), id);
  const p3 = readFileSync(out(dir, 'P3'), 'utf8');
  assert.match(p3, /Errors are typed/);
  assert.doesNotMatch(p3, /The API has one call/);
});

test('--check: missing, fresh and stale slices', () => {
  const dir = project({}, files());
  assert.equal(slice(dir, '--packet', 'P1', '--check').status, 1);
  slice(dir, '--packet', 'P1');
  assert.equal(slice(dir, '--packet', 'P1', '--check').status, 0);
  writeFileSync(join(dir, 'docs/specs/Feat.md'), SPEC().replace('one call', 'two calls'));
  const r = slice(dir, '--packet', 'P1', '--check');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /stale/i);
});

test('a draft spec is carried as spec_status draft', () => {
  const dir = project({}, files('draft'));
  slice(dir, '--packet', 'P1');
  assert.match(readFileSync(out(dir, 'P1'), 'utf8'), /spec_status: draft/);
});

test('over budget fails with "split it" unless --allow-over', () => {
  const dir = project({ harness: { packetSlice: { budgetTokens: 10 } } }, files());
  const r = slice(dir, '--packet', 'P1');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /too big, split it/);
  assert.equal(slice(dir, '--packet', 'P1', '--allow-over').status, 0);
});

test('an unknown section is a hard error; an unknown packet and bad arguments are rejected', () => {
  const dir = project({}, { ...files(), [BRIEF]: files()[BRIEF].replace('**Spec:** DATA', '**Spec:** NOSUCH') });
  const r = slice(dir, '--packet', 'P2');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /NOSUCH/);
  assert.notEqual(slice(dir, '--packet', 'P9').status, 0);
  assert.equal(run(S('agents', 'packet-slice.mjs'), [], { cwd: dir }).status, 2);
});

test('--check --all with no handoff folder is fine', () => {
  const dir = project();
  assert.equal(run(S('agents', 'packet-slice.mjs'), ['--check', '--all'], { cwd: dir }).status, 0);
});
