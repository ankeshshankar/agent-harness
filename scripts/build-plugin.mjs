#!/usr/bin/env node
/**
 * Builds the parts of the Claude Code plugin that scripts/sync-agents.mjs does not generate.
 *
 *   node scripts/build-plugin.mjs            write them
 *   node scripts/build-plugin.mjs --check    exit 1 if any of them is missing, stale or stray
 *   node scripts/build-plugin.mjs --root <dir>   work on another copy of the repository
 *
 * Written under plugins/agent-harness/ (agents/ and skills/ come from the sync):
 *
 *   .claude-plugin/plugin.json   name, version (from package.json), description, author, licence
 *   hooks/hooks.json             the hooks of scripts/hooks/manifest.json whose default is "on"
 *   scripts/hooks/              the hook scripts and their lib, copied
 *   template/                   the project files the `init` skill and the installer scaffold
 *   LICENSE
 * and, at the repository root:
 *   .claude-plugin/marketplace.json
 *
 * Zero dependencies. Idempotent: a second run writes nothing.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const rootFlag = argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? resolve(argv[rootFlag + 1] ?? '.') : join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'plugins/agent-harness';

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const pkg = readJson('package.json');
const manifest = readJson('scripts/hooks/manifest.json');

/** Every file under rel (a file or a folder), as repo-relative posix paths, sorted. */
function walk(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [rel];
  const out = [];
  for (const name of readdirSync(abs).sort()) {
    if (name === '.DS_Store') continue;
    out.push(...walk(`${rel}/${name}`));
  }
  return out;
}

const want = new Map(); // repo-relative path -> { data: Buffer, mode: number }
const add = (rel, data, mode = 0o644) => want.set(rel, { data: Buffer.isBuffer(data) ? data : Buffer.from(data), mode });
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
const copy = (from, to) => add(to, readFileSync(join(ROOT, from)), statSync(join(ROOT, from)).mode & 0o111 ? 0o755 : 0o644);

// ---- plugin.json and marketplace.json
add(
  `${PLUGIN}/.claude-plugin/plugin.json`,
  json({
    name: 'agent-harness',
    version: pkg.version,
    description:
      'A spec, build, review, verify workflow for coding agents: eight roles, nine skills, three safety hooks and packet scripts. Run /agent-harness:init to scaffold the project files.',
    author: { name: 'Ankesh Kumar' },
    license: 'MIT',
    repository: 'https://github.com/ankeshshankar/agent-harness',
    keywords: ['agents', 'workflow', 'spec', 'review', 'verification'],
  }),
);
add(
  '.claude-plugin/marketplace.json',
  json({
    name: 'agent-harness',
    owner: { name: 'Ankesh Kumar' },
    metadata: { description: 'The agent-harness plugin: a spec, build, review, verify workflow for coding agents.' },
    plugins: [
      {
        name: 'agent-harness',
        source: `./${PLUGIN}`,
        description: 'Roles, skills, safety hooks and packet scripts for a spec, build, review, verify workflow.',
        version: pkg.version,
        author: { name: 'Ankesh Kumar' },
        license: 'MIT',
        repository: 'https://github.com/ankeshshankar/agent-harness',
      },
    ],
  }),
);

// ---- hooks/hooks.json: only the hooks that are on by default
const events = {};
for (const h of manifest.hooks.filter((x) => x.default === 'on')) {
  const groups = (events[h.event] ??= []);
  let group = groups.find((g) => g.matcher === h.matcher);
  if (!group) groups.push((group = { ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [] }));
  group.hooks.push({
    type: 'command',
    command: 'node',
    args: [`\${CLAUDE_PLUGIN_ROOT}/${h.script}`, ...(h.args ?? [])],
    timeout: h.timeout,
  });
}
add(`${PLUGIN}/hooks/hooks.json`, json({ hooks: events }));

// ---- scripts/hooks: scripts and lib the hooks run
for (const f of walk('scripts/hooks')) copy(f, `${PLUGIN}/${f}`);
copy('LICENSE', `${PLUGIN}/LICENSE`);

// ---- template/: the project files that get scaffolded
const TEMPLATE = `${PLUGIN}/template`;
const templateFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  'agents.config.schema.json',
  ...walk('.agents'),
  'scripts/sync-agents.mjs',
  'scripts/verify.mjs',
  ...walk('scripts/agents'),
  ...walk('scripts/bin'),
  ...walk('scripts/hooks'),
  ...walk('docs/templates'),
  'docs/memory-format.md',
];
for (const f of templateFiles) copy(f, `${TEMPLATE}/${f}`);
// The project's own config: same keys, without the plugin target (a project does not build the plugin).
const config = readJson('agents.config.json');
config.targets.plugin.enabled = false;
config.commands = { lint: '', typecheck: '', test: '', verify: 'node scripts/sync-agents.mjs --check' };
add(`${TEMPLATE}/agents.config.json`, json(config));
add(`${TEMPLATE}/gitignore-snippet.txt`, '# agent-harness: local state, logs and worktrees\n.agent-harness/\n');

// ---- compare with disk, or write
const owned = [`${PLUGIN}/.claude-plugin`, `${PLUGIN}/hooks`, `${PLUGIN}/scripts`, `${PLUGIN}/template`, `${PLUGIN}/LICENSE`, '.claude-plugin'];
const onDisk = owned.flatMap((o) => walk(o));
const problems = [];
let written = 0;
for (const [rel, { data, mode }] of want) {
  const abs = join(ROOT, rel);
  const current = existsSync(abs) ? readFileSync(abs) : null;
  if (current && current.equals(data)) continue;
  if (check) problems.push(`${current ? 'stale' : 'missing'}: ${rel}`);
  else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    chmodSync(abs, mode);
    written++;
  }
}
let removed = 0;
for (const rel of onDisk) {
  if (want.has(rel)) continue;
  if (check) problems.push(`stray: ${rel}`);
  else {
    rmSync(join(ROOT, rel));
    removed++;
  }
}
if (!check) {
  // Drop folders the removal left empty.
  const prune = (dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const n of readdirSync(dir)) prune(join(dir, n));
    if (!readdirSync(dir).length) rmSync(dir, { recursive: true });
  };
  for (const o of owned) prune(join(ROOT, o));
}

if (check) {
  if (problems.length) {
    console.error(`build-plugin --check: ${problems.length} problem(s). Run: node scripts/build-plugin.mjs`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`build-plugin --check: ${want.size} files current.`);
} else {
  console.log(`build-plugin: ${want.size} files, ${written} written, ${removed} removed.`);
}
