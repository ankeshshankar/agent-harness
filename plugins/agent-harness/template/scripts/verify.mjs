#!/usr/bin/env node
/**
 * The generic gate: runs the project's own commands from agents.config.json
 * in a fixed order (lint, typecheck, test, verify), one result line per step.
 *
 *   node scripts/verify.mjs [--root <dir>] [--bail]
 *
 * - An unset or empty command is SKIPPED, and the line says so.
 * - Output of each step goes to <root>/.agent-harness/logs/<step>.log; the
 *   last lines are shown for a failed step.
 * - Exit 0 only if no step failed and at least one step ran. A gate that
 *   checks nothing does not pass.
 * - --bail stops at the first failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const root =
  rootFlag >= 0 ? resolve(argv[rootFlag + 1] ?? '.') : join(dirname(fileURLToPath(import.meta.url)), '..');
const bail = argv.includes('--bail');
const STEPS = ['lint', 'typecheck', 'test', 'verify'];

const configFile = join(root, 'agents.config.json');
if (!existsSync(configFile)) {
  console.error(`verify: agents.config.json not found in ${root}`);
  process.exit(2);
}
let config;
try {
  config = JSON.parse(readFileSync(configFile, 'utf8'));
} catch (e) {
  console.error(`verify: agents.config.json is not valid JSON: ${e.message}`);
  process.exit(2);
}
const commands = config.commands ?? {};
const logDir = join(root, '.agent-harness', 'logs');

const results = [];
for (const step of STEPS) {
  const cmd = typeof commands[step] === 'string' ? commands[step].trim() : '';
  if (!cmd) {
    results.push({ step, status: 'SKIP' });
    console.log(`SKIP  ${step.padEnd(9)} commands.${step} is not set in agents.config.json`);
    continue;
  }
  const started = Date.now();
  const res = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, `${step}.log`), output);
  const ok = res.status === 0;
  results.push({ step, status: ok ? 'PASS' : 'FAIL' });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${step.padEnd(9)} exit ${res.status ?? 'signal'}  ${secs}s  ${cmd}${ok ? '' : `  (log: .agent-harness/logs/${step}.log)`}`,
  );
  if (!ok) {
    const tail = output.trimEnd().split('\n').slice(-15).join('\n');
    if (tail) console.log(tail.replace(/^/gm, '      | '));
    if (bail) break;
  }
}

const failed = results.filter((r) => r.status === 'FAIL');
const ran = results.filter((r) => r.status !== 'SKIP');
if (failed.length) {
  console.log(`\nFAIL (${failed.map((r) => r.step).join(', ')})`);
  process.exit(1);
}
if (!ran.length) {
  console.log('\nFAIL: no command is configured, so nothing was checked. Set commands.* in agents.config.json.');
  process.exit(1);
}
console.log(`\nPASS (${ran.length} ran, ${results.length - ran.length} skipped)`);
