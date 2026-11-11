#!/usr/bin/env node
/**
 * One agent definition, every tool.
 *
 * Source of truth is `.agents/`:
 *
 *   .agents/roles/<role>.md        one agent role; neutral frontmatter (below)
 *   .agents/skills/<name>/SKILL.md one skill (name, description)
 *   .agents/playbook/role-footer.md  appended to every role body
 *   .agents/playbook/<rule>.md       turned into a Cursor rule (.mdc)
 *   agents.config.json             targets, names, models, paths, commands
 *
 * Role frontmatter (flat `key: value`, no nesting):
 *
 *   name         the role id; must match the file name
 *   description  when to dispatch it
 *   tools        readonly | write      (readonly = analysis only, no edit tools)
 *   model        light | standard | reasoning   (a TIER, never a model name)
 *
 * Targets (each can be switched off in agents.config.json):
 *
 *   claude   <dir>/agents/<name>.md   + <dir>/skills/<skill>/SKILL.md
 *   cursor   <dir>/agents/<name>.md   + <dir>/rules/<rule>.mdc
 *   codex    <dir>/agents/<name>.toml
 *   plugin   <dir>/agents/<name>.md   + <dir>/skills/<skill>/SKILL.md
 *            (a Claude Code plugin: only frontmatter fields plugins honour)
 *
 * Text placeholders `{{paths.specs}}`, `{{project.name}}`, `{{defaultBranch}}`,
 * `{{packageManager}}` and `{{commands.test}}` are replaced from the config.
 * Names of roles inside prose are rewritten per target when a prefix or a
 * name map is set.
 *
 *   node scripts/sync-agents.mjs            regenerate
 *   node scripts/sync-agents.mjs --check    exit 1 if any generated file is stale
 *   node scripts/sync-agents.mjs --root <dir>   work on another project folder
 *
 * Zero dependencies. Idempotent: a second run writes nothing.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const rootFlag = argv.indexOf('--root');
const root =
  rootFlag >= 0
    ? resolve(argv[rootFlag + 1] ?? '.')
    : join(dirname(fileURLToPath(import.meta.url)), '..');

const SRC = join(root, '.agents');
const TIERS = ['light', 'standard', 'reasoning'];
const TOOL_CLASSES = ['readonly', 'write'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MARK = 'generated from .agents/';

/**
 * Claude Code has no readonly flag: the tool list is the flag. Neither list
 * contains `Agent`. A role that can dispatch other roles can dispatch the one
 * that reviews it, which turns the gate into a self-approving loop.
 * Bash is in both lists, so readonly means "will not edit", not "cannot run
 * a command". The commands that need a human are listed in
 * .agents/playbook/20-side-effects.md.
 */
const CLAUDE_TOOLS = {
  readonly: 'Read, Grep, Glob, Bash, WebSearch, WebFetch',
  write: 'Read, Grep, Glob, Bash, WebSearch, WebFetch, Write, Edit',
};
const CODEX_SANDBOX = { readonly: 'read-only', write: 'workspace-write' };

/** Frontmatter fields Claude Code honours in a PLUGIN agent. */
class ConfigError extends Error {}
const fail = (msg) => {
  throw new ConfigError(msg);
};

// --- reading -----------------------------------------------------------------

function parse(raw, file) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) fail(`${file}: missing --- frontmatter block`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i === -1) fail(`${file}: cannot parse frontmatter line: ${line}`);
    let value = line.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        /* keep raw */
      }
    }
    meta[line.slice(0, i).trim()] = value;
  }
  return { meta, body: raw.slice(m[0].length).replace(/^\n+/, '') };
}

const q = (s) => JSON.stringify(s);

function frontmatter(pairs) {
  return [
    '---',
    ...pairs.filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => `${k}: ${v}`),
    '---',
  ].join('\n');
}

function loadConfig() {
  const file = join(root, 'agents.config.json');
  if (!existsSync(file)) fail(`agents.config.json not found in ${root}`);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`agents.config.json is not valid JSON: ${e.message}`);
  }
  if (!config.project?.name) fail('agents.config.json: project.name is required');
  if (!config.targets || typeof config.targets !== 'object') fail('agents.config.json: targets is required');
  if (config.rolePrefix && !/^([a-z0-9]+(-[a-z0-9]+)*-)?$/.test(config.rolePrefix))
    fail('agents.config.json: rolePrefix must be lowercase words and hyphens and end with "-"');
  return config;
}

function loadRoles() {
  const dir = join(SRC, 'roles');
  if (!existsSync(dir)) fail('.agents/roles/ not found');
  const roles = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const { meta, body } = parse(readFileSync(join(dir, f), 'utf8'), `.agents/roles/${f}`);
      const expected = f.replace(/\.md$/, '');
      if (meta.name !== expected) fail(`.agents/roles/${f}: name "${meta.name}" does not match the file name`);
      for (const key of ['description', 'tools', 'model'])
        if (!meta[key]) fail(`.agents/roles/${f}: missing frontmatter key "${key}"`);
      if (!TOOL_CLASSES.includes(meta.tools))
        fail(`.agents/roles/${f}: tools must be one of ${TOOL_CLASSES.join(' | ')}`);
      if (!TIERS.includes(meta.model))
        fail(`.agents/roles/${f}: model must be a tier (${TIERS.join(' | ')}), not a model name`);
      return { file: f, meta, body };
    });
  if (!roles.length) fail('.agents/roles/ contains no roles');
  return roles;
}

function loadSkills() {
  const dir = join(SRC, 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const rel = `.agents/skills/${name}/SKILL.md`;
      if (!existsSync(join(root, rel))) fail(`${rel}: missing`);
      const { meta, body } = parse(readFileSync(join(root, rel), 'utf8'), rel);
      if (meta.name !== name) fail(`${rel}: name "${meta.name}" must match its folder "${name}"`);
      if (!NAME_RE.test(name)) fail(`${rel}: name must be lowercase letters, digits and hyphens`);
      if (!meta.description) fail(`${rel}: missing description`);
      return { name, meta, body };
    });
}

function loadRules() {
  const dir = join(SRC, 'playbook');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'role-footer.md')
    .sort()
    .map((f) => {
      const { meta, body } = parse(readFileSync(join(dir, f), 'utf8'), `.agents/playbook/${f}`);
      return { name: f.replace(/\.md$/, ''), file: f, meta, body };
    });
}

// --- placeholders and names --------------------------------------------------

function lookup(config, key) {
  let v = config;
  for (const part of key.split('.')) v = v?.[part];
  return v;
}

function fill(text, config, owner) {
  return text.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const v = lookup(config, key);
    if (v === undefined || typeof v === 'object')
      fail(`${owner}: placeholder {{${key}}} has no value in agents.config.json`);
    return v === '' ? '(not configured)' : String(v);
  });
}

/** Output name of a role for one target: name map first, then prefix. */
function namesFor(targetName, target, config, roles) {
  const map = target.roleNames ?? {};
  const prefix = target.rolePrefix ?? config.rolePrefix ?? '';
  const out = {};
  for (const k of Object.keys(map))
    if (!roles.some((r) => r.meta.name === k)) fail(`agents.config.json: targets.${targetName}.roleNames has unknown role "${k}"`);
  const seen = new Map();
  for (const { meta } of roles) {
    const name = map[meta.name] ?? `${prefix}${meta.name}`;
    if (!NAME_RE.test(name)) fail(`agents.config.json: targets.${targetName}: role name "${name}" must be lowercase words and hyphens`);
    if (seen.has(name)) fail(`agents.config.json: targets.${targetName}: "${name}" is used by both ${seen.get(name)} and ${meta.name}`);
    seen.set(name, meta.name);
    out[meta.name] = name;
  }
  return out;
}

/** Rewrite role names that stand alone in prose; never inside paths or file names. */
function rename(text, names) {
  const changed = Object.entries(names).filter(([a, b]) => a !== b);
  if (!changed.length) return text;
  const map = Object.fromEntries(changed);
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\w/.-])(${keys.join('|')})(?![\\w-]|\\.(md|toml|mdc)\\b)`, 'g');
  return text.replace(re, (m) => map[m]);
}

function modelFor(config, tool, role) {
  const m = config.models?.[tool] ?? {};
  return m.roles?.[role.meta.name] ?? m.tiers?.[role.meta.model];
}

function effortFor(config, tool, role) {
  const e = config.models?.[tool]?.efforts ?? {};
  const v = e[role.meta.name] ?? e['*'];
  if (v && !EFFORTS.includes(v)) fail(`agents.config.json: models.${tool}.efforts has "${v}"; use one of ${EFFORTS.join(', ')}`);
  return v;
}

// --- emitters ----------------------------------------------------------------

const header = (src) => `<!-- ${MARK}${src} — do not edit. Edit the source, then run: node scripts/sync-agents.mjs -->`;
const tomlHeader = (src) => `# ${MARK}${src} — do not edit. Edit the source, then run: node scripts/sync-agents.mjs`;

const EMITTERS = {
  claude: (role, name, ctx) =>
    `${frontmatter([
      ['name', name],
      ['description', q(ctx.description)],
      ['tools', CLAUDE_TOOLS[role.meta.tools]],
      ['model', ctx.model],
      ['effort', ctx.effort],
    ])}\n\n${header(`roles/${role.meta.name}.md`)}\n\n${ctx.body}`,

  cursor: (role, name, ctx) =>
    `${frontmatter([
      ['name', name],
      ['description', q(ctx.description)],
      ['model', ctx.model],
      ['readonly', role.meta.tools === 'readonly' ? 'true' : 'false'],
    ])}\n\n${header(`roles/${role.meta.name}.md`)}\n\n${ctx.body}`,

  // Plugin agents: only fields Claude Code honours in a plugin
  // (no permissionMode, hooks or mcpServers).
  plugin: (role, name, ctx) =>
    `${frontmatter([
      ['name', name],
      ['description', q(ctx.description)],
      ['tools', CLAUDE_TOOLS[role.meta.tools]],
      ['model', ctx.model],
      ['effort', ctx.effort],
    ])}\n\n${header(`roles/${role.meta.name}.md`)}\n\n${ctx.body}`,

  codex: (role, name, ctx) => {
    if (ctx.body.includes("'''"))
      fail(`.agents/roles/${role.meta.name}.md: body contains ''' and cannot be a TOML literal string`);
    return [
      tomlHeader(`roles/${role.meta.name}.md`),
      `name = ${q(name)}`,
      `description = ${q(ctx.description)}`,
      ctx.model ? `model = ${q(ctx.model)}` : null,
      ctx.effort ? `model_reasoning_effort = ${q(ctx.effort)}` : null,
      `sandbox_mode = ${q(CODEX_SANDBOX[role.meta.tools])}`,
      `developer_instructions = '''\n${ctx.body.trimEnd()}\n'''`,
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
  },
};

const SUFFIX = { claude: '.md', cursor: '.md', plugin: '.md', codex: '.toml' };

// --- writing -----------------------------------------------------------------

const stale = [];
let written = 0;

function emitFile(rel, text, why) {
  const abs = join(root, rel);
  const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  if (current === text) return;
  if (check) stale.push(`${rel}${why ? ` (${why})` : ''}`);
  else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    written++;
  }
}

/** Remove generated files in `dir` that no source produces any more. */
function sweep(dirRel, expected, suffix) {
  const dir = join(root, dirRel);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(suffix) || expected.has(f)) continue;
    const abs = join(dir, f);
    if (!readFileSync(abs, 'utf8').includes(MARK)) continue; // hand-made file, not ours
    if (check) stale.push(`${dirRel}/${f} (orphaned, no matching source)`);
    else {
      rmSync(abs);
      written++;
    }
  }
}

function sweepSkills(dirRel, expected) {
  const dir = join(root, dirRel);
  if (!existsSync(dir)) return;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || expected.has(d.name)) continue;
    const f = join(dir, d.name, 'SKILL.md');
    if (!existsSync(f) || !readFileSync(f, 'utf8').includes(MARK)) continue;
    if (check) stale.push(`${dirRel}/${d.name} (orphaned, no matching source)`);
    else {
      rmSync(join(dir, d.name), { recursive: true });
      written++;
    }
  }
}

// --- main --------------------------------------------------------------------

function main() {
  const config = loadConfig();
  const roles = loadRoles();
  const skills = loadSkills();
  const rules = loadRules();

  const footerFile = config.roleFooter ? join(root, config.roleFooter) : null;
  if (config.roleFooter && !existsSync(footerFile))
    fail(`agents.config.json: roleFooter names ${config.roleFooter}, which does not exist`);
  const footer = footerFile ? readFileSync(footerFile, 'utf8').trim() : '';

  const enabled = Object.entries(config.targets).filter(([, t]) => t.enabled);
  for (const [name] of enabled) if (!EMITTERS[name]) fail(`agents.config.json: no emitter for target "${name}"`);

  let firstNames = null;
  for (const [tool, target] of enabled) {
    const names = namesFor(tool, target, config, roles);
    firstNames ??= names;
    const dir = target.dir;
    const expected = new Set();

    for (const role of roles) {
      const model = modelFor(config, tool, role);
      if (Object.keys(config.models?.[tool]?.tiers ?? {}).length && !model)
        fail(`agents.config.json: models.${tool} does not map tier "${role.meta.model}" (role ${role.meta.name})`);
      for (const r of Object.keys(config.models?.[tool]?.roles ?? {}))
        if (!roles.some((x) => x.meta.name === r)) fail(`agents.config.json: models.${tool}.roles has unknown role "${r}"`);
      const owner = `.agents/roles/${role.file}`;
      const bodyRaw = footer ? `${role.body.trimEnd()}\n\n${footer}\n` : `${role.body.trimEnd()}\n`;
      const ctx = {
        model,
        effort: effortFor(config, tool, role),
        description: rename(fill(role.meta.description, config, owner), names),
        body: rename(fill(bodyRaw, config, owner), names),
      };
      const out = `${names[role.meta.name]}${SUFFIX[tool]}`;
      expected.add(out);
      emitFile(`${dir}/agents/${out}`, EMITTERS[tool](role, names[role.meta.name], ctx), `from ${owner}`);
    }
    sweep(`${dir}/agents`, expected, SUFFIX[tool]);

    if (target.skills) {
      const skillNames = new Set();
      for (const s of skills) {
        const owner = `.agents/skills/${s.name}/SKILL.md`;
        const text = `${frontmatter([
          ['name', s.name],
          ['description', q(rename(fill(s.meta.description, config, owner), names))],
        ])}\n\n${header(`skills/${s.name}/SKILL.md`)}\n\n${rename(fill(s.body.trimEnd(), config, owner), names)}\n`;
        skillNames.add(s.name);
        emitFile(`${dir}/skills/${s.name}/SKILL.md`, text, `from ${owner}`);
      }
      sweepSkills(`${dir}/skills`, skillNames);
    }

    if (tool === 'cursor') {
      const expectedRules = new Set();
      for (const r of rules) {
        const owner = `.agents/playbook/${r.file}`;
        const text = `${frontmatter([
          ['description', q(fill(r.meta.description ?? r.name, config, owner))],
          ['globs', r.meta.globs],
          ['alwaysApply', r.meta.alwaysApply ?? 'false'],
        ])}\n\n${header(`playbook/${r.file}`)}\n\n${fill(r.body.trimEnd(), config, owner)}\n`;
        expectedRules.add(`${r.name}.mdc`);
        emitFile(`${dir}/rules/${r.name}.mdc`, text, `from ${owner}`);
      }
      sweep(`${dir}/rules`, expectedRules, '.mdc');
    }
  }

  // Roles table in AGENTS.md, between the markers, when the file has them.
  const agentsMd = join(root, 'AGENTS.md');
  const START = '<!-- agents:start -->';
  const END = '<!-- agents:end -->';
  if (existsSync(agentsMd) && firstNames) {
    const doc = readFileSync(agentsMd, 'utf8');
    const a = doc.indexOf(START);
    const b = doc.indexOf(END);
    if (a !== -1 && b > a) {
      const table = [
        '',
        '| Agent | Source role | Tools | Tier | Use for |',
        '| --- | --- | --- | --- | --- |',
        ...roles.map(
          ({ meta }) =>
            `| \`${firstNames[meta.name]}\` | ${meta.name} | ${meta.tools} | ${meta.model} | ${rename(fill(meta.description, config, "AGENTS.md"), firstNames).split(". ")[0].replace(/\.$/, "").replace(/\|/g, "\\|")}. |`,
        ),
        '',
        '',
      ].join('\n');
      const next = `${doc.slice(0, a + START.length)}\n${table}${doc.slice(b)}`;
      if (next !== doc) {
        if (check) stale.push('AGENTS.md (roles table)');
        else {
          writeFileSync(agentsMd, next);
          written++;
        }
      }
    }
  }

  const summary = `${roles.length} roles, ${skills.length} skills, ${rules.length} rules, ${enabled.length} targets`;
  if (check) {
    if (stale.length) {
      console.error(`Stale generated files:\n${stale.map((s) => `  - ${s}`).join('\n')}`);
      console.error('\nRun `node scripts/sync-agents.mjs` and commit the result.');
      process.exit(1);
    }
    console.log(`sync-agents --check: ${summary}, all generated files current.`);
  } else {
    console.log(`sync-agents: ${summary}, ${written} file(s) written.`);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`sync-agents: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
