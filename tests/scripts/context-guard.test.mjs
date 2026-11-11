import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, latestUsage } from '../../scripts/hooks/context-guard.mjs';
import { S, project, run } from './_helpers.mjs';

test('evaluate: below the limit clears state', () => {
  assert.deepEqual(evaluate(100, 5000, 150000, 100000), { remind: false, lastAt: null });
});
test('evaluate: first crossing reminds', () => {
  assert.deepEqual(evaluate(160000, null, 150000, 100000), { remind: true, lastAt: 160000 });
});
test('evaluate: no repeat until one step further', () => {
  assert.equal(evaluate(200000, 160000, 150000, 100000).remind, false);
  assert.equal(evaluate(260000, 160000, 150000, 100000).remind, true);
});
test('evaluate: a compaction (context dropped below last) re-arms', () => {
  assert.equal(evaluate(155000, 300000, 150000, 100000).remind, true);
});

const line = (o) => `${JSON.stringify(o)}\n`;
const asst = (n) => line({ type: 'assistant', message: { usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

test('latestUsage returns the last assistant usage and skips junk', () => {
  const dir = project();
  const f = join(dir, 't.jsonl');
  writeFileSync(f, asst(1) + line({ type: 'user' }) + asst(7) + 'not json\n' + line({ type: 'user' }));
  assert.equal(latestUsage(f).input_tokens, 7);
});
test('latestUsage of an empty transcript is null', () => {
  const dir = project();
  const f = join(dir, 't.jsonl');
  writeFileSync(f, '');
  assert.equal(latestUsage(f), null);
});

test('hook: reminds once at the threshold, then stays quiet', () => {
  const dir = project({ harness: { contextGuard: { tokens: 1000, step: 1000, message: 'ctx {k}K' } } });
  const f = join(dir, 't.jsonl');
  writeFileSync(f, asst(2000));
  const input = JSON.stringify({ session_id: 's1', transcript_path: f });
  const a = run(S('hooks', 'context-guard.mjs'), [], { cwd: dir, input });
  assert.equal(a.status, 0);
  assert.equal(JSON.parse(a.stdout).hookSpecificOutput.additionalContext, 'ctx 2K');
  const b = run(S('hooks', 'context-guard.mjs'), [], { cwd: dir, input });
  assert.equal(b.stdout.trim(), '');
});
test('hook: off switch and bad input stay silent', () => {
  const dir = project({ harness: { contextGuard: { tokens: 1 } } });
  const f = join(dir, 't.jsonl');
  writeFileSync(f, asst(2000));
  const off = run(S('hooks', 'context-guard.mjs'), [], { cwd: dir, env: { AGENT_HARNESS_CONTEXT_GUARD: 'off' }, input: JSON.stringify({ session_id: 's', transcript_path: f }) });
  assert.equal(off.stdout.trim(), '');
  const bad = run(S('hooks', 'context-guard.mjs'), [], { cwd: dir, input: 'garbage' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.trim(), '');
});
