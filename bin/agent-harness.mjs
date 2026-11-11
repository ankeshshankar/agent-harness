#!/usr/bin/env node
// agent-harness installer. Zero dependencies.
//
//   agent-harness init [dir]     copy the kit's project files into dir (default: the current folder)
//   agent-harness update [dir]   refresh the kit-owned files; never touches your config or AGENTS.md
//   agent-harness doctor [dir]   check node, config, generated files and hooks
//
// Flags (init): --tools claude,cursor,codex  --prefix <name>  --with-hooks  --dry-run  --force
// Flags (update): --dry-run  --force
// Exit codes: 0 ok, 1 a check failed, 2 bad arguments or a write error.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from './lib/schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, '..', 'plugins', 'agent-harness', 'template');
const LOCK = '.agents/.kit.json';
const TOOLS = ['claude', 'cursor', 'codex'];
// Files that belong to the project once they are written. update never touches them.
const USER_OWNED = new Set(['agents.config.json', 'AGENTS.md', 'CLAUDE.md', 'gitignore-snippet.txt']);
const out = (s = '') => process.stdout.write(`${s}\n`);
const sha = (b) => createHash('sha256').update(b).digest('hex');

function die(msg, code = 2) {
  process.stderr.write(`agent-harness: ${msg}\n`);
  process.exit(code);
}

const USAGE = `agent-harness <init|update|doctor> [dir] [flags]

  init [dir]    copy the kit's project files into dir (default: current folder), then run the sync
                --tools claude,cursor,codex   targets to generate (default: all three)
                --prefix <name>               prefix for agent names, for example acme gives acme-builder
                --with-hooks                  add the default-on hooks to .claude/settings.json
                --dry-run                     print what would be written, write nothing
                --force                       overwrite files that already exist
  update [dir]  refresh kit-owned files that you have not changed; --dry-run, --force
  doctor [dir]  check node version, config, generated files and hook wiring
`;

function parse(argv) {
  const o = { cmd: argv[0], dir: null, tools: [...TOOLS], prefix: '', withHooks: false, dryRun: false, force: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with-hooks') o.withHooks = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--tools' || a === '--prefix') {
      const v = argv[++i];
      if (!v) die(`${a} needs a value`);
      if (a === '--tools') {
        o.tools = v.split(',').map((s) => s.trim()).filter(Boolean);
        const bad = o.tools.filter((t) => !TOOLS.includes(t));
        if (bad.length || !o.tools.length) die(`--tools takes a list from: ${TOOLS.join(', ')}`);
      } else o.prefix = v;
    } else if (a.startsWith('-')) die(`unknown flag ${a}\n\n${USAGE}`);
    else if (!o.dir) o.dir = a;
    else die(`unexpected argument ${a}`);
  }
  if (o.prefix) {
    o.prefix = o.prefix.endsWith('-') ? o.prefix : `${o.prefix}-`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*-$/.test(o.prefix)) die('--prefix must be lower-case letters, digits and hyphens');
  }
  o.target = resolve(o.dir ?? '.');
  return o;
}

/** Every file under dir, as posix paths relative to dir, sorted. */
function walk(dir, rel = '') {
  const abs = join(dir, rel);
  if (!existsSync(abs)) return [];
  const files = [];
  for (const name of readdirSync(abs).sort()) {
    if (name === '.DS_Store' || name === 'node_modules' || name === '.git') continue;
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, r)).isDirectory()) files.push(...walk(dir, r));
    else files.push(r);
  }
  return files;
}

function templateFiles() {
  if (!existsSync(TEMPLATE)) die(`template folder not found: ${TEMPLATE}. Run: node scripts/build-plugin.mjs`);
  return walk(TEMPLATE);
}

/** The bytes init writes for one template file, or null to skip it. */
function content(rel, o) {
  let data = readFileSync(join(TEMPLATE, rel));
  if (rel === 'CLAUDE.md' && !o.tools.includes('claude')) return null;
  if (rel === 'agents.config.json') {
    const cfg = JSON.parse(data.toString('utf8'));
    for (const t of TOOLS) cfg.targets[t].enabled = o.tools.includes(t);
    if (o.prefix) cfg.rolePrefix = o.prefix;
    data = Buffer.from(`${JSON.stringify(cfg, null, 2)}\n`);
  }
  return data;
}

function readLock(target) {
  try {
    return JSON.parse(readFileSync(join(target, LOCK), 'utf8'));
  } catch {
    return { version: null, files: {} };
  }
}

function writeFile(target, rel, data, mode) {
  const abs = join(target, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  if (mode) chmodSync(abs, mode);
}
const modeOf = (rel) => (statSync(join(TEMPLATE, rel)).mode & 0o111 ? 0o755 : 0o644);
const kitVersion = () => JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;

function runSync(target, dryRun) {
  const before = new Set(walk(target).filter((f) => !f.startsWith('.git/')));
  const r = spawnSync(process.execPath, ['scripts/sync-agents.mjs'], { cwd: target, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout);
    die('the sync failed in the target folder', 1);
  }
  out(r.stdout.trim());
  const after = walk(target);
  const created = after.filter((f) => !before.has(f));
  for (const f of created) out(`  generate ${f}`);
  return created.length;
}

// ---------------------------------------------------------------- hooks

function hookCommand(h) {
  const parts = [`node "$CLAUDE_PROJECT_DIR/${h.script}"`, ...(h.args ?? [])];
  return parts.join(' ');
}

/** Adds the default-on hooks to settings; returns { settings, added }. */
export function mergeHooks(settings, manifest) {
  const next = JSON.parse(JSON.stringify(settings));
  next.hooks ??= {};
  const added = [];
  for (const h of manifest.hooks.filter((x) => x.default === 'on')) {
    const command = hookCommand(h);
    const groups = (next.hooks[h.event] ??= []);
    const exists = groups.some((g) => (g.hooks ?? []).some((x) => x.command === command));
    if (exists) continue;
    let group = groups.find((g) => g.matcher === h.matcher && (h.matcher || g.matcher === undefined));
    if (!group) groups.push((group = { ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [] }));
    (group.hooks ??= []).push({ type: 'command', command, timeout: h.timeout });
    added.push(h.id);
  }
  return { settings: next, added };
}

function wireHooks(o) {
  const manifest = JSON.parse(readFileSync(join(TEMPLATE, 'scripts/hooks/manifest.json'), 'utf8'));
  const rel = '.claude/settings.json';
  const abs = join(o.target, rel);
  let settings = {};
  if (existsSync(abs)) {
    try {
      settings = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      die(`${rel} is not valid JSON; fix it or merge the hooks by hand (see scripts/hooks/manifest.json)`);
    }
  }
  const { settings: next, added } = mergeHooks(settings, manifest);
  if (!added.length) return out(`  hooks    ${rel}: already wired`);
  out(`  ${o.dryRun ? 'would merge' : 'merge'} hooks into ${rel}: ${added.join(', ')} (existing hooks kept)`);
  if (!o.dryRun) writeFile(o.target, rel, `${JSON.stringify(next, null, 2)}\n`);
}

// ---------------------------------------------------------------- init

function init(o) {
  if (o.withHooks && !o.tools.includes('claude')) die('--with-hooks writes .claude/settings.json, so --tools must include claude');
  if (existsSync(o.target) && !statSync(o.target).isDirectory()) die(`${o.target} is not a folder`);
  const lock = readLock(o.target);
  const files = {};
  const log = { create: [], overwrite: [], same: [], skip: [], none: [] };
  out(`agent-harness init ${o.dryRun ? '(dry run) ' : ''}-> ${o.target}`);
  out(`tools: ${o.tools.join(', ')}${o.prefix ? `; prefix: ${o.prefix}` : ''}`);

  for (const rel of templateFiles()) {
    if (rel === 'gitignore-snippet.txt') continue;
    const data = content(rel, o);
    if (data === null) {
      log.none.push(rel);
      continue;
    }
    const abs = join(o.target, rel);
    const exists = existsSync(abs);
    if (exists && readFileSync(abs).equals(data)) {
      log.same.push(rel);
      files[rel] = sha(data);
    } else if (exists && !o.force) {
      log.skip.push(rel);
      if (lock.files[rel]) files[rel] = lock.files[rel];
    } else {
      log[exists ? 'overwrite' : 'create'].push(rel);
      files[rel] = sha(data);
      if (!o.dryRun) writeFile(o.target, rel, data, modeOf(rel));
    }
  }

  // .gitignore: add the state folder.
  const gi = join(o.target, '.gitignore');
  const snippet = readFileSync(join(TEMPLATE, 'gitignore-snippet.txt'), 'utf8');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const needGi = !giText.split(/\r?\n/).some((l) => l.trim() === '.agent-harness/' || l.trim() === '.agent-harness');
  if (needGi && !o.dryRun) writeFileSync(gi, `${giText}${giText && !giText.endsWith('\n') ? '\n' : ''}${giText ? '\n' : ''}${snippet}`);

  for (const rel of log.create) out(`  ${o.dryRun ? 'would create' : 'create'}    ${rel}`);
  for (const rel of log.overwrite) out(`  ${o.dryRun ? 'would overwrite' : 'overwrite'} ${rel}`);
  if (needGi) out(`  ${o.dryRun ? 'would add' : 'add'}       .agent-harness/ to .gitignore`);
  for (const rel of log.skip) out(`  skip      ${rel} (exists and differs; use --force to overwrite)`);
  for (const rel of log.none) out(`  omit      ${rel} (not needed for --tools ${o.tools.join(',')})`);
  if (log.same.length) out(`  ${log.same.length} file(s) already identical`);

  if (o.dryRun) {
    if (o.withHooks) wireHooks(o);
    out(`dry run: ${log.create.length} to create, ${log.overwrite.length} to overwrite, ${log.skip.length} skipped. Nothing was written.`);
    return;
  }
  if (!o.dryRun && (log.create.length || log.overwrite.length || !existsSync(join(o.target, LOCK)))) {
    writeFile(o.target, LOCK, `${JSON.stringify({ version: kitVersion(), files }, null, 2)}\n`);
    out(`  write     ${LOCK}`);
  }
  if (o.withHooks) wireHooks(o);
  const generated = runSync(o.target, o.dryRun);
  out(`done: ${log.create.length} created, ${log.overwrite.length} overwritten, ${log.skip.length} skipped, ${generated} generated.`);
  if (!existsSync(join(o.target, '.git'))) out('note: this folder is not a git repository; the agents expect one.');
  out('next: fill in "Your project\'s rules" in AGENTS.md and set the commands in agents.config.json, then run: node scripts/verify.mjs');
}

// ---------------------------------------------------------------- update

function update(o) {
  if (!existsSync(join(o.target, 'agents.config.json'))) die('no agents.config.json here; run init first');
  const lock = readLock(o.target);
  const files = { ...lock.files };
  const counts = { update: 0, create: 0, kept: 0, same: 0 };
  out(`agent-harness update ${o.dryRun ? '(dry run) ' : ''}-> ${o.target} (kit ${kitVersion()}, installed ${lock.version ?? 'unknown'})`);
  for (const rel of templateFiles()) {
    if (USER_OWNED.has(rel)) continue;
    const data = readFileSync(join(TEMPLATE, rel));
    const abs = join(o.target, rel);
    if (!existsSync(abs)) {
      counts.create++;
      out(`  ${o.dryRun ? 'would create' : 'create'}  ${rel}`);
      if (!o.dryRun) writeFile(o.target, rel, data, modeOf(rel));
      files[rel] = sha(data);
      continue;
    }
    const have = readFileSync(abs);
    if (have.equals(data)) {
      counts.same++;
      files[rel] = sha(data);
      continue;
    }
    const untouched = lock.files[rel] && sha(have) === lock.files[rel];
    if (untouched || o.force) {
      counts.update++;
      out(`  ${o.dryRun ? 'would update' : 'update'}  ${rel}${o.force && !untouched ? ' (forced)' : ''}`);
      if (!o.dryRun) writeFile(o.target, rel, data, modeOf(rel));
      files[rel] = sha(data);
    } else {
      counts.kept++;
      out(`  keep    ${rel} (changed by you; use --force to overwrite)`);
    }
  }
  out('  never touched: agents.config.json, AGENTS.md, CLAUDE.md and every file you created');
  if (o.dryRun) return out(`dry run: ${counts.update} to update, ${counts.create} to create, ${counts.kept} kept. Nothing was written.`);
  writeFile(o.target, LOCK, `${JSON.stringify({ version: kitVersion(), files }, null, 2)}\n`);
  const generated = runSync(o.target, false);
  out(`done: ${counts.update} updated, ${counts.create} created, ${counts.kept} kept, ${counts.same} unchanged, ${generated} generated.`);
}

// ---------------------------------------------------------------- doctor

function doctor(o) {
  let failed = 0;
  const line = (state, text) => {
    if (state === 'FAIL') failed++;
    out(`${state.padEnd(4)}  ${text}`);
  };
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20 ? 'ok' : 'FAIL', `node ${process.versions.node} (needs 20 or newer)`);
  line(spawnSync('git', ['--version']).status === 0 ? 'ok' : 'warn', 'git available');
  const cfgPath = join(o.target, 'agents.config.json');
  if (!existsSync(cfgPath)) {
    line('FAIL', `agents.config.json not found in ${o.target}`);
    return process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    line('FAIL', `agents.config.json is not valid JSON: ${e.message}`);
    return process.exit(1);
  }
  const schemaPath = join(o.target, 'agents.config.schema.json');
  if (existsSync(schemaPath)) {
    const errors = validate(JSON.parse(readFileSync(schemaPath, 'utf8')), cfg);
    if (errors.length) {
      line('FAIL', `agents.config.json breaks its schema (${errors.length})`);
      for (const e of errors.slice(0, 10)) out(`        ${e}`);
    } else line('ok', 'agents.config.json matches its schema');
  } else line('warn', 'agents.config.schema.json missing; config not validated');

  const sync = join(o.target, 'scripts/sync-agents.mjs');
  if (existsSync(sync)) {
    const r = spawnSync(process.execPath, [sync, '--check'], { cwd: o.target, encoding: 'utf8' });
    line(r.status === 0 ? 'ok' : 'FAIL', r.status === 0 ? 'generated files are current' : `generated files are stale; run: node scripts/sync-agents.mjs\n${(r.stderr || r.stdout).trim()}`);
  } else line('FAIL', 'scripts/sync-agents.mjs missing; run: agent-harness init');

  const lock = readLock(o.target);
  line(lock.version ? 'ok' : 'warn', lock.version ? `kit files installed from version ${lock.version}` : `${LOCK} missing (files were not installed by this installer)`);

  const manifestPath = join(o.target, 'scripts/hooks/manifest.json');
  const settingsPath = join(o.target, '.claude/settings.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {}
    const { added } = mergeHooks(settings, manifest);
    const on = manifest.hooks.filter((h) => h.default === 'on').length;
    if (!added.length) line('ok', `default-on hooks wired in .claude/settings.json (${on})`);
    else line('warn', `hooks not wired: ${added.join(', ')} (optional; run: agent-harness init --with-hooks)`);
  } else line('warn', 'scripts/hooks/manifest.json missing; hooks not checked');
  out(failed ? `doctor: ${failed} check(s) failed` : 'doctor: all required checks passed');
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- main

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    out(USAGE);
    process.exit(argv.length ? 0 : 2);
  }
  const o = parse(argv);
  if (o.cmd === 'init') init(o);
  else if (o.cmd === 'update') update(o);
  else if (o.cmd === 'doctor') doctor(o);
  else die(`unknown command ${o.cmd}\n\n${USAGE}`);
}
