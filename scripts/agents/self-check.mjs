#!/usr/bin/env node
// scripts/agents/self-check.mjs - a cheap mechanical check of the files an agent just edited.
//
//   node scripts/agents/self-check.mjs <file> [<file> ...]
//
// It catches, before a reviewer does, the leftovers that review keeps flagging: merge-conflict markers,
// focused tests (it.only, fdescribe), skipped tests, truncation markers ("// ..." left in a file) and
// TODO / FIXME notes. Then it runs the project's format check on exactly those files, if one is set.
// No test run, no typecheck: any agent can run it after every edit.
//
// FAIL means a break a reviewer always flags (exit 1). WARN is listed so the agent can justify it.
// Code lines are matched after string literals and `//` comments are blanked, so prose in a string
// is not reported. Rules marked "raw" see the whole line (they look inside comments).
//
// Config (agents.config.json, key "harness.selfCheck"):
//   rules      extra rules: [{ "level": "FAIL"|"WARN", "id": "any-type", "pattern": "<regex>",
//              "message": "<what to do>", "raw": false, "extensions": [".ts", ".tsx"] }]
//   defaults   false switches the built-in rules off
//   format     a command to check formatting, "{files}" is replaced by the file list, e.g.
//              "pnpm exec prettier --check --ignore-unknown {files}". Unset = no format check.
// Files that do not exist are reported as MISSING (exit 1). Non-code extensions are skipped.
// Exit codes: 0 clean, 1 findings, 2 no files given.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { findRoot, get, isMain, loadConfig } from '../hooks/lib/common.mjs';

const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.cs', '.php', '.sh']);

const DEFAULT_RULES = [
  { level: 'FAIL', id: 'conflict', raw: true, pattern: '^(<<<<<<<|>>>>>>>)( |$)|^=======$', message: 'merge-conflict marker' },
  { level: 'FAIL', id: 'focused', pattern: '\\b(?:it|test|describe)\\.only\\s*\\(|\\bf(?:it|describe)\\s*\\(', message: 'focused test' },
  { level: 'WARN', id: 'skipped', pattern: '\\b(?:it|test|describe)\\.skip\\s*\\(|\\bx(?:it|describe|test)\\s*\\(', message: 'skipped test: say why in your report' },
  { level: 'FAIL', id: 'truncated', raw: true, pattern: '^\\s*(?://|#)\\s*\\.\\.\\.\\s*$|/\\*\\s*\\.\\.\\.\\s*\\*/', message: 'truncation marker: write the whole file' },
  { level: 'WARN', id: 'todo', raw: true, pattern: '\\b(?:TODO|FIXME|XXX)\\b', message: 'TODO / placeholder left behind' },
];

/** Blank string literals and line comments so prose cannot trip a rule. */
export function strip(line) {
  return line
    .replace(/\\./g, '__')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, (s) => s[0] + ' '.repeat(s.length - 2) + s[0])
    .replace(/\/\/.*$/, '');
}

export function compileRules(cfg) {
  const rules = [...(get(cfg, 'harness.selfCheck.defaults', true) ? DEFAULT_RULES : []), ...get(cfg, 'harness.selfCheck.rules', [])];
  const out = [];
  for (const r of rules) {
    try {
      out.push({ ...r, level: r.level === 'WARN' ? 'WARN' : 'FAIL', re: new RegExp(r.pattern), id: r.id ?? 'rule', message: r.message ?? r.id ?? 'rule' });
    } catch {
      // skip a bad pattern
    }
  }
  return out;
}

/** Findings for one file's text: [{ level, line, id, message, text }]. */
export function checkText(text, ext, rules) {
  const findings = [];
  let inBlock = false;
  text.split('\n').forEach((raw, i) => {
    const hit = (r) => findings.push({ level: r.level, line: i + 1, id: r.id, message: r.message, text: raw.trim() });
    for (const r of rules) {
      if (r.raw && (!r.extensions || r.extensions.includes(ext)) && r.re.test(raw)) hit(r);
    }
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open !== -1) {
      line = line.slice(0, open);
      inBlock = true;
    }
    const code = strip(line);
    for (const r of rules) {
      if (!r.raw && (!r.extensions || r.extensions.includes(ext)) && r.re.test(code)) hit(r);
    }
  });
  return findings;
}

function main() {
  const files = process.argv.slice(2).filter((f) => !f.startsWith('-'));
  if (!files.length) {
    console.error('usage: node scripts/agents/self-check.mjs <file> [<file> ...]');
    process.exit(2);
  }
  const root = findRoot();
  const cfg = loadConfig(root);
  const rules = compileRules(cfg);
  const findings = [];
  const missing = [];
  for (const file of files) {
    if (!existsSync(file)) {
      missing.push(file);
      continue;
    }
    const ext = extname(file);
    if (!CODE.has(ext)) continue;
    for (const f of checkText(readFileSync(file, 'utf8'), ext, rules)) findings.push({ ...f, file });
  }
  const print = (t) => process.stdout.write(`${t}\n`);
  print(`self-check: ${files.length} file(s)`);
  if (missing.length) print(`\nMISSING (listed but not on disk):\n  ${missing.join('\n  ')}`);
  for (const level of ['FAIL', 'WARN']) {
    const hits = findings.filter((f) => f.level === level);
    if (hits.length) print(`\n${level} (${hits.length}):\n${hits.map((f) => `${f.file}:${f.line}  [${f.id}] ${f.message}\n    ${f.text}`).join('\n')}`);
  }
  let formatFailed = false;
  const format = get(cfg, 'harness.selfCheck.format', '');
  const present = files.filter((f) => existsSync(f));
  if (typeof format === 'string' && format.trim() && present.length) {
    const quoted = present.map((f) => `'${f.replaceAll("'", `'\\''`)}'`).join(' ');
    const r = spawnSync('sh', ['-c', format.replace('{files}', quoted)], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) {
      formatFailed = true;
      print(`\nFORMAT CHECK FAILED:\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim()}`);
    }
  }
  const failed = missing.length > 0 || findings.some((f) => f.level === 'FAIL') || formatFailed;
  print(failed ? '\nself-check: FAIL' : '\nself-check: clean');
  process.exit(failed ? 1 : 0);
}

if (isMain(import.meta.url)) main();
