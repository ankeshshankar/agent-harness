import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../../bin/lib/schema.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO, 'bin', 'agent-harness.mjs');
const made = [];
process.on('exit', () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ah-inst-'));
  made.push(d);
  return d;
};
const ah = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd: cwd ?? REPO, encoding: 'utf8', timeout: 60000 });
const list = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? list(dir, r) : [r];
  });
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

test('fresh install writes the kit, runs the sync and passes the checks', () => {
  const d = temp();
  const r = ah(['init', d]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'agents.config.json', 'agents.config.schema.json', 'scripts/sync-agents.mjs', 'scripts/verify.mjs', 'scripts/agents/run-packet.sh', 'scripts/hooks/manifest.json', 'docs/templates/build-brief.md', 'docs/memory-format.md', '.agents/roles/builder.md', '.claude/agents/builder.md', '.cursor/rules/00-core.mdc', '.codex/agents/builder.toml', '.agents/.kit.json']) {
    assert.ok(existsSync(join(d, f)), `missing ${f}`);
  }
  assert.ok(statSync(join(d, 'scripts/agents/run-packet.sh')).mode & 0o111, 'run-packet.sh is executable');
  assert.match(readFileSync(join(d, '.gitignore'), 'utf8'), /^\.agent-harness\/$/m);
  assert.match(r.stdout, /created, 0 overwritten, 0 skipped/);
  // nothing from the kit's own repository
  assert.ok(!existsSync(join(d, 'plugins')) && !existsSync(join(d, 'tests')) && !existsSync(join(d, 'bin')));
  assert.equal(spawnSync(process.execPath, ['scripts/sync-agents.mjs', '--check'], { cwd: d }).status, 0);
  assert.equal(spawnSync(process.execPath, ['scripts/verify.mjs'], { cwd: d }).status, 0);
  const doc = ah(['doctor', d]);
  assert.equal(doc.status, 0, doc.stdout);
  assert.match(doc.stdout, /generated files are current/);
});

test('running init again changes nothing', () => {
  const d = temp();
  ah(['init', d]);
  const before = Object.fromEntries(list(d).map((f) => [f, sha(join(d, f))]));
  const r = ah(['init', d]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 created, 0 overwritten, 0 skipped, 0 generated/);
  assert.deepEqual(Object.fromEntries(list(d).map((f) => [f, sha(join(d, f))])), before);
});

test('an existing file is kept and listed; --force overwrites it', () => {
  const d = temp();
  writeFileSync(join(d, 'AGENTS.md'), 'mine\n');
  writeFileSync(join(d, '.gitignore'), 'node_modules/\n');
  const r = ah(['init', d]);
  assert.equal(readFileSync(join(d, 'AGENTS.md'), 'utf8'), 'mine\n');
  assert.match(r.stdout, /skip\s+AGENTS\.md/);
  assert.match(readFileSync(join(d, '.gitignore'), 'utf8'), /^node_modules\/\n[\s\S]*\.agent-harness\/$/m);
  ah(['init', d, '--force']);
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /^# AGENTS\.md/);
});

test('--tools claude writes no cursor or codex files', () => {
  const d = temp();
  const r = ah(['init', d, '--tools', 'claude']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(d, '.claude/agents/builder.md')));
  assert.ok(!existsSync(join(d, '.cursor')) && !existsSync(join(d, '.codex')));
  const cfg = JSON.parse(readFileSync(join(d, 'agents.config.json'), 'utf8'));
  assert.deepEqual([cfg.targets.claude.enabled, cfg.targets.cursor.enabled, cfg.targets.codex.enabled], [true, false, false]);
  assert.equal(ah(['doctor', d]).status, 0);
});

test('--tools cursor omits CLAUDE.md and .claude', () => {
  const d = temp();
  assert.equal(ah(['init', d, '--tools', 'cursor']).status, 0);
  assert.ok(!existsSync(join(d, 'CLAUDE.md')) && !existsSync(join(d, '.claude')));
  assert.ok(existsSync(join(d, '.cursor/agents/builder.md')));
});

test('--prefix renames the generated agents', () => {
  const d = temp();
  assert.equal(ah(['init', d, '--prefix', 'acme']).status, 0);
  assert.equal(JSON.parse(readFileSync(join(d, 'agents.config.json'), 'utf8')).rolePrefix, 'acme-');
  assert.ok(existsSync(join(d, '.claude/agents/acme-builder.md')));
  assert.notEqual(ah(['init', d, '--prefix', 'Bad Name']).status, 0);
});

test('--with-hooks adds the default-on hooks and keeps an existing hook', () => {
  const d = temp();
  mkdirSync(join(d, '.claude'));
  const mine = { permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(mine));
  const r = ah(['init', d, '--with-hooks']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions, mine.permissions);
  assert.deepEqual(s.hooks.Stop, mine.hooks.Stop);
  const bash = s.hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks.map((h) => h.command);
  assert.ok(bash.includes('echo mine'));
  assert.ok(bash.some((c) => c.includes('scripts/hooks/guard-command.mjs" --format claude')));
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === 'Read'));
  assert.ok(s.hooks.UserPromptSubmit[0].hooks[0].command.includes('context-guard.mjs'));
  assert.ok(!JSON.stringify(s).includes('heavy-gate') && !JSON.stringify(s).includes('packet-runner'));
  // second run adds nothing
  const before = readFileSync(join(d, '.claude/settings.json'), 'utf8');
  ah(['init', d, '--with-hooks']);
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), before);
  assert.match(ah(['doctor', d]).stdout, /default-on hooks wired/);
});

test('--with-hooks refuses a settings file that is not JSON and leaves it alone', () => {
  const d = temp();
  mkdirSync(join(d, '.claude'));
  writeFileSync(join(d, '.claude/settings.json'), '{ not json');
  const r = ah(['init', d, '--with-hooks']);
  assert.equal(r.status, 2);
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), '{ not json');
});

test('--dry-run writes nothing', () => {
  const d = temp();
  const r = ah(['init', d, '--dry-run', '--with-hooks']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would create\s+AGENTS\.md/);
  assert.match(r.stdout, /Nothing was written/);
  assert.deepEqual(readdirSync(d), []);
});

test('update refreshes files you did not change, keeps the rest, never touches the config', () => {
  const d = temp();
  ah(['init', d]);
  const cfgPath = join(d, 'agents.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.project.name = 'mine';
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  writeFileSync(join(d, 'AGENTS.md'), '# mine\n');
  // an old kit file the user never touched: the lock holds its hash
  const old = join(d, 'scripts/agents/self-check.mjs');
  writeFileSync(old, '// old version\n');
  const lockPath = join(d, '.agents/.kit.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.files['scripts/agents/self-check.mjs'] = sha(old);
  writeFileSync(lockPath, JSON.stringify(lock));
  // a kit file the user edited
  const edited = join(d, 'docs/templates/spec.md');
  writeFileSync(edited, 'my own spec template\n');
  // a file the user created
  writeFileSync(join(d, '.agents/roles/mine.md'), '---\nname: mine\ndescription: x\ntools: readonly\nmodel: light\n---\nbody\n');
  const cfgBefore = readFileSync(cfgPath, 'utf8');

  const dry = ah(['update', d, '--dry-run']);
  assert.match(dry.stdout, /would update\s+scripts\/agents\/self-check\.mjs/);
  assert.equal(readFileSync(old, 'utf8'), '// old version\n');

  const r = ah(['update', d]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.notEqual(readFileSync(old, 'utf8'), '// old version\n');
  assert.equal(readFileSync(edited, 'utf8'), 'my own spec template\n');
  assert.match(r.stdout, /keep\s+docs\/templates\/spec\.md/);
  assert.equal(readFileSync(cfgPath, 'utf8'), cfgBefore);
  assert.equal(readFileSync(join(d, 'AGENTS.md'), 'utf8'), '# mine\n');
  assert.ok(existsSync(join(d, '.agents/roles/mine.md')));
  assert.ok(existsSync(join(d, '.claude/agents/mine.md')), 'the sync ran and generated the user role');
});

test('doctor fails when a generated file is stale and when the config breaks its schema', () => {
  const d = temp();
  ah(['init', d]);
  writeFileSync(join(d, '.claude/agents/builder.md'), 'stale\n');
  const r = ah(['doctor', d]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+generated files are stale/);
  ah(['init', d, '--force']);
  const cfgPath = join(d, 'agents.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.harness.queue.maxConcurrent = 9;
  cfg.harness.bogus = 1;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r2 = ah(['doctor', d]);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /breaks its schema/);
  assert.match(r2.stdout, /harness\.bogus: unknown key/);
});

test('the repository config and the shipped template config match the schema', () => {
  const schema = JSON.parse(readFileSync(join(REPO, 'agents.config.schema.json'), 'utf8'));
  for (const f of ['agents.config.json', 'plugins/agent-harness/template/agents.config.json']) {
    assert.deepEqual(validate(schema, JSON.parse(readFileSync(join(REPO, f), 'utf8'))), [], f);
  }
  assert.ok(validate(schema, { project: {}, targets: {}, models: {} }).length > 0);
});

test('the config documents every harness key the scripts read', () => {
  const schema = JSON.parse(readFileSync(join(REPO, 'agents.config.schema.json'), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(REPO, 'agents.config.json'), 'utf8'));
  const readme = readFileSync(join(REPO, 'scripts/hooks/README.md'), 'utf8');
  const keys = [...readme.matchAll(/^\| `(harness\.[A-Za-z.]+)`/gm)].map((m) => m[1]);
  assert.ok(keys.length > 20);
  const at = (o, path) => path.reduce((x, k) => x?.[k], o);
  for (const key of keys) {
    const path = key.split('.');
    // "harness.heavy.lane`, `.narrow" rows list siblings after the first key; the first is enough here
    assert.notEqual(at(cfg, path), undefined, `agents.config.json lacks ${key}`);
    const sp = path.flatMap((k, i) => (i === 0 ? ['properties', k] : ['properties', k]));
    assert.ok(at(schema, sp)?.description || at(schema, sp)?.type, `schema lacks ${key}`);
  }
});
