import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNC = join(repo, 'scripts', 'sync-agents.mjs');

const PLUGIN_FIELDS = new Set([
  'name', 'description', 'model', 'effort', 'maxTurns', 'tools', 'disallowedTools',
  'skills', 'memory', 'background', 'isolation', 'color',
]);

function baseConfig(extra = {}) {
  return {
    project: { name: 'fixture' },
    rolePrefix: '',
    packageManager: 'npm',
    defaultBranch: 'main',
    commands: { test: 'echo test' },
    paths: { specs: 'docs/specs', rules: 'docs/rules', reports: '.agent-harness/reports' },
    roleFooter: '.agents/playbook/role-footer.md',
    models: {
      claude: { tiers: { light: 'haiku', standard: 'sonnet', reasoning: 'opus' }, roles: {}, efforts: { builder: 'high' } },
      cursor: { tiers: { light: 'inherit', standard: 'inherit', reasoning: 'inherit' } },
      codex: { tiers: {}, efforts: { '*': 'high' } },
      plugin: { tiers: { light: 'haiku', standard: 'sonnet', reasoning: 'opus' } },
    },
    targets: {
      claude: { enabled: true, dir: '.claude', skills: true },
      cursor: { enabled: true, dir: '.cursor', skills: false },
      codex: { enabled: true, dir: '.codex', skills: false },
      plugin: { enabled: true, dir: 'plugins/kit', rolePrefix: '', skills: true },
    },
    ...extra,
  };
}

function fixture(config = baseConfig()) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-fixture-'));
  const w = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  w('agents.config.json', JSON.stringify(config, null, 2));
  w(
    '.agents/roles/builder.md',
    '---\nname: builder\ndescription: Builds things: carefully, per spec.\ntools: write\nmodel: standard\n---\n\nYou build. Ask the reviewer when unsure. Specs live in {{paths.specs}}.\nSee .agents/roles/reviewer.md for the reviewer.\n',
  );
  w(
    '.agents/roles/reviewer.md',
    '---\nname: reviewer\ndescription: Reviews things.\ntools: readonly\nmodel: reasoning\n---\n\nYou review the builder\'s work.\n',
  );
  w('.agents/skills/demo/SKILL.md', '---\nname: demo\ndescription: A demo skill. Hand it to the builder.\n---\n\n# demo\n\nTests: {{commands.test}}.\n');
  w('.agents/playbook/role-footer.md', '## Footer\n\nReports go to {{paths.reports}}.\n');
  w('.agents/playbook/00-rule.md', '---\ndescription: A rule\nalwaysApply: true\n---\n\n# Rule\n\nBody.\n');
  w('AGENTS.md', '# Guide\n\n<!-- agents:start -->\n<!-- agents:end -->\n\nTail.\n');
  return { dir, w, read: (rel) => readFileSync(join(dir, rel), 'utf8'), has: (rel) => existsSync(join(dir, rel)) };
}

const sync = (dir, ...args) =>
  spawnSync(process.execPath, [SYNC, '--root', dir, ...args], { encoding: 'utf8' });

const frontKeys = (text) =>
  text.match(/^---\n([\s\S]*?)\n---/)[1].split('\n').map((l) => l.split(':')[0]);

test('sync generates all four targets from a fixture', () => {
  const f = fixture();
  const r = sync(f.dir);
  assert.equal(r.status, 0, r.stderr);
  for (const p of [
    '.claude/agents/builder.md', '.claude/agents/reviewer.md', '.claude/skills/demo/SKILL.md',
    '.cursor/agents/builder.md', '.cursor/rules/00-rule.mdc',
    '.codex/agents/builder.toml', '.codex/agents/reviewer.toml',
    'plugins/kit/agents/builder.md', 'plugins/kit/skills/demo/SKILL.md',
  ])
    assert.ok(f.has(p), `missing ${p}`);
  const claude = f.read('.claude/agents/builder.md');
  assert.match(claude, /^name: builder$/m);
  assert.match(claude, /^model: sonnet$/m);
  assert.match(claude, /^effort: high$/m);
  assert.match(claude, /^tools: Read, Grep, Glob, Bash, WebSearch, WebFetch, Write, Edit$/m);
  assert.match(claude, /generated from \.agents\/roles\/builder\.md — do not edit/);
  assert.match(claude, /Specs live in docs\/specs\./); // placeholder filled
  assert.match(claude, /Reports go to \.agent-harness\/reports\./); // footer appended
  assert.match(claude, /description: ".*Builds things: carefully, per spec\."/); // colon-safe YAML
  assert.doesNotMatch(f.read('.claude/agents/reviewer.md'), /Write, Edit/); // readonly has no edit tools
  assert.match(f.read('.cursor/agents/reviewer.md'), /^readonly: true$/m);
  assert.match(f.read('.cursor/rules/00-rule.mdc'), /alwaysApply: true/);
  const toml = f.read('.codex/agents/reviewer.toml');
  assert.match(toml, /sandbox_mode = "read-only"/);
  assert.match(toml, /model_reasoning_effort = "high"/);
  assert.doesNotMatch(toml, /^model = /m); // empty tier map: inherit the session model
  assert.match(f.read('.claude/skills/demo/SKILL.md'), /Tests: echo test\./);
  assert.match(f.read('AGENTS.md'), /\| `builder` \| builder \| write \| standard \|/);
  assert.match(f.read('AGENTS.md'), /Tail\./);
});

test('sync is idempotent', () => {
  const f = fixture();
  assert.equal(sync(f.dir).status, 0);
  const second = sync(f.dir);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /0 file\(s\) written/);
});

test('--check passes when current and exits 1 naming a stale file', () => {
  const f = fixture();
  sync(f.dir);
  assert.equal(sync(f.dir, '--check').status, 0);
  writeFileSync(join(f.dir, '.cursor/agents/builder.md'), 'hand edited\n');
  const stale = sync(f.dir, '--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /\.cursor\/agents\/builder\.md/);
  // a changed source also makes the copies stale
  sync(f.dir);
  f.w('.agents/roles/reviewer.md', '---\nname: reviewer\ndescription: Reviews things.\ntools: readonly\nmodel: reasoning\n---\n\nChanged.\n');
  const stale2 = sync(f.dir, '--check');
  assert.equal(stale2.status, 1);
  assert.match(stale2.stderr, /reviewer/);
  // check never writes
  assert.match(f.read('.claude/agents/reviewer.md'), /You review the builder/);
});

test('rolePrefix and per-target name maps apply, and prose follows', () => {
  const cfg = baseConfig({ rolePrefix: 'acme-' });
  cfg.targets.cursor.roleNames = { builder: 'maker' };
  const f = fixture(cfg);
  assert.equal(sync(f.dir).status, 0);
  // prefix on claude and codex
  assert.ok(f.has('.claude/agents/acme-builder.md'));
  assert.ok(f.has('.claude/agents/acme-reviewer.md'));
  assert.ok(f.has('.codex/agents/acme-builder.toml'));
  assert.ok(!f.has('.claude/agents/builder.md'));
  assert.match(f.read('.claude/agents/acme-builder.md'), /^name: acme-builder$/m);
  assert.match(f.read('.claude/agents/acme-builder.md'), /Ask the acme-reviewer when unsure/);
  assert.match(f.read('.claude/agents/acme-builder.md'), /\.agents\/roles\/reviewer\.md/); // paths untouched
  // name map beats the prefix for that role only
  assert.ok(f.has('.cursor/agents/maker.md'));
  assert.ok(f.has('.cursor/agents/acme-reviewer.md'));
  // the plugin target has its own empty prefix
  assert.ok(f.has('plugins/kit/agents/builder.md'));
  assert.ok(!f.has('plugins/kit/agents/acme-builder.md'));
  // skills text follows the target's names
  assert.match(f.read('.claude/skills/demo/SKILL.md'), /Hand it to the acme-builder/);
  assert.match(f.read('plugins/kit/skills/demo/SKILL.md'), /Hand it to the builder/);
  assert.equal(sync(f.dir, '--check').status, 0);
});

test('a role name map that collides or names an unknown role is rejected', () => {
  const dup = baseConfig();
  dup.targets.claude.roleNames = { builder: 'same', reviewer: 'same' };
  const f1 = fixture(dup);
  const r1 = sync(f1.dir);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /same/);
  const unknown = baseConfig();
  unknown.targets.claude.roleNames = { ghost: 'boo' };
  const r2 = sync(fixture(unknown).dir);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /unknown role "ghost"/);
});

test('plugin agents carry no frontmatter fields that plugins ignore', () => {
  const f = fixture();
  sync(f.dir);
  const dir = join(f.dir, 'plugins/kit/agents');
  const files = readdirSync(dir);
  assert.equal(files.length, 2);
  for (const file of files) {
    for (const key of frontKeys(readFileSync(join(dir, file), 'utf8')))
      assert.ok(PLUGIN_FIELDS.has(key), `${file}: "${key}" is not a plugin agent field`);
    const text = readFileSync(join(dir, file), 'utf8');
    for (const banned of ['permissionMode', 'hooks:', 'mcpServers'])
      assert.ok(!text.match(/^---\n[\s\S]*?\n---/)[0].includes(banned), `${file}: ${banned}`);
  }
});

test('the committed plugin agents in this repository carry no ignored fields', () => {
  const dir = join(repo, 'plugins/agent-harness/agents');
  assert.ok(existsSync(dir));
  for (const file of readdirSync(dir))
    for (const key of frontKeys(readFileSync(join(dir, file), 'utf8')))
      assert.ok(PLUGIN_FIELDS.has(key), `${file}: "${key}"`);
});

test('a disabled target is not generated; an orphaned generated file is removed, a hand-made one kept', () => {
  const cfg = baseConfig();
  cfg.targets.codex.enabled = false;
  const f = fixture(cfg);
  sync(f.dir);
  assert.ok(!f.has('.codex'));
  f.w('.claude/agents/hand-made.md', '---\nname: hand-made\n---\nmine\n');
  sync(f.dir);
  rmSync(join(f.dir, '.agents/roles/reviewer.md'));
  const chk = sync(f.dir, '--check');
  assert.equal(chk.status, 1);
  assert.match(chk.stderr, /reviewer\.md \(orphaned/);
  sync(f.dir);
  assert.ok(!f.has('.claude/agents/reviewer.md'));
  assert.ok(f.has('.claude/agents/hand-made.md'));
});

test('bad input fails with a clear message and exit 2', () => {
  const f = fixture();
  f.w('.agents/roles/builder.md', '---\nname: builder\ndescription: x\ntools: write\nmodel: gpt-9\n---\nbody\n');
  const r = sync(f.dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /tier/);
  const g = fixture();
  g.w('.agents/roles/builder.md', '---\nname: builder\ndescription: x\ntools: write\nmodel: standard\n---\nUses {{paths.nope}}.\n');
  const r2 = sync(g.dir);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /paths\.nope/);
  const h = fixture();
  h.w('.agents/roles/builder.md', '---\nname: wrong\ndescription: x\ntools: write\nmodel: standard\n---\nbody\n');
  assert.equal(sync(h.dir).status, 2);
});

test('this repository is in sync (--check)', () => {
  const r = spawnSync(process.execPath, [SYNC, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
