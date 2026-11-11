// Shared helpers for the script tests. Not a test file (no tests inside).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const S = (...p) => join(REPO, 'scripts', ...p);
const made = [];
process.on('exit', () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A temp project folder with an agents.config.json made from cfg. */
export function project(cfg = {}, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-test-'));
  made.push(dir);
  writeFileSync(join(dir, 'agents.config.json'), JSON.stringify({ project: { name: 't' }, defaultBranch: 'main', ...cfg }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** Run a node script in a project; env is clean of harness variables. */
export function run(script, args, { cwd, input, env = {} } = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('AGENT_HARNESS_') || k === 'CLAUDE_PROJECT_DIR' || k === 'CI') delete base[k];
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...base, AGENT_HARNESS_ROOT: cwd, ...env },
    timeout: 20000,
  });
}
