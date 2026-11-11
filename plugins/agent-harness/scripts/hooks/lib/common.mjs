// scripts/hooks/lib/common.mjs - shared helpers for the harness scripts. Not run on its own.
//
// Project root: AGENT_HARNESS_ROOT, else CLAUDE_PROJECT_DIR, else the nearest parent of the
// working directory that holds agents.config.json or .git, else the working directory.
// Config: <root>/agents.config.json (optional; a missing or broken file gives {}).
// State: <root>/<harness.stateDir> (default .agent-harness, git-ignored), or AGENT_HARNESS_STATE.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function findRoot(start = process.cwd()) {
  const env = process.env.AGENT_HARNESS_ROOT || process.env.CLAUDE_PROJECT_DIR;
  if (env) return resolve(env);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'agents.config.json')) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function loadConfig(root = findRoot()) {
  try {
    const data = JSON.parse(readFileSync(join(root, 'agents.config.json'), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** get(cfg, 'harness.guard.deny', []) - dotted path with a default. */
export function get(cfg, path, fallback) {
  let cur = cfg;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return fallback;
    cur = cur[key];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

export function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function stateDir(root, cfg = loadConfig(root)) {
  const dir = process.env.AGENT_HARNESS_STATE || get(cfg, 'harness.stateDir', '.agent-harness');
  return isAbsolute(dir) ? dir : join(root, dir);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read all of stdin as JSON. Returns {} when empty or invalid. */
export function readStdinJson() {
  try {
    const text = readFileSync(0, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** Compile config patterns (strings) to RegExp; bad patterns are skipped. */
export function compileAll(patterns) {
  const out = [];
  for (const p of Array.isArray(patterns) ? patterns : []) {
    try {
      out.push(new RegExp(typeof p === 'string' ? p : p.pattern));
    } catch {
      // a bad pattern must not disable the script
    }
  }
  return out;
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && new URL(metaUrl).pathname === resolve(process.argv[1]);
}
