#!/usr/bin/env node
// scripts/agents/config-get.mjs - print one value from agents.config.json for shell scripts.
//
//   node scripts/agents/config-get.mjs <dotted.key> [default]
//
// Prints the value (strings as they are, arrays one item per line, other JSON as JSON), or the
// default (empty when none is given) when the file or the key is missing. The project is found
// from AGENT_HARNESS_ROOT, CLAUDE_PROJECT_DIR, or the working directory. Exit code: 0 always,
// 2 without a key.
import { findRoot, get, loadConfig } from '../hooks/lib/common.mjs';

const [key, fallback = ''] = process.argv.slice(2);
if (!key) {
  process.stderr.write('usage: config-get.mjs <dotted.key> [default]\n');
  process.exit(2);
}
const value = get(loadConfig(findRoot()), key, undefined);
if (value === undefined) process.stdout.write(`${fallback}\n`);
else if (typeof value === 'string') process.stdout.write(`${value}\n`);
else if (Array.isArray(value)) process.stdout.write(`${value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n')}\n`);
else process.stdout.write(`${JSON.stringify(value)}\n`);
