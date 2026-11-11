#!/usr/bin/env node
// scripts/hooks/status-delta.mjs - print only the rows of a markdown status file that changed.
//
//   node scripts/hooks/status-delta.mjs <status-file> [--key <name>] [--reset]
//
// First run for a key prints the whole file and saves a snapshot. Later runs print, per table,
// the header plus each new or changed row (rows are matched by their first cell), a line
// "removed: <first cell>" for each deleted row, and any changed non-table line. With no change
// it prints "no change since HH:MM". The snapshot is then updated. --reset clears the snapshot.
// Use it to post a periodic status without repeating rows nobody touched.
//
// Env: AGENT_HARNESS_STATE overrides the state folder; the default is <project>/.agent-harness.
// Snapshot: <stateDir>/status-<key>.md (git-ignored).
// Exit codes: 0 always (on any error the whole file is printed), 2 for a missing file argument.
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { ensureDir, findRoot, isMain, loadConfig, stateDir } from './lib/common.mjs';

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function parse(text) {
  const tables = [];
  const other = [];
  let t = null;
  for (const line of text.split('\n')) {
    if (isRow(line)) {
      if (!t) {
        t = { header: line, rows: new Map() };
        tables.push(t);
        continue;
      }
      if (isSep(line)) continue;
      t.rows.set(cells(line)[0], line);
    } else {
      t = null;
      if (line.trim()) other.push(line);
    }
  }
  return { tables, other };
}

/** The delta between two status texts, as lines. Empty array = no change. */
export function delta(prevText, curText) {
  const a = parse(prevText);
  const b = parse(curText);
  const out = [];
  b.tables.forEach((t, i) => {
    const old = a.tables.find((x) => x.header === t.header) ?? a.tables[i];
    const lines = [];
    for (const [k, line] of t.rows) if (!old || old.rows.get(k) !== line) lines.push(line);
    if (old) for (const k of old.rows.keys()) if (!t.rows.has(k)) lines.push(`removed: ${k}`);
    if (lines.length) out.push(t.header, ...lines);
  });
  a.tables.forEach((t, i) => {
    if (!b.tables.find((x) => x.header === t.header) && !b.tables[i]) {
      for (const k of t.rows.keys()) out.push(`removed: ${k}`);
    }
  });
  const oldOther = new Set(a.other);
  for (const l of b.other) if (!oldOther.has(l)) out.push(l);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  let key = 'default';
  const ki = args.indexOf('--key');
  if (ki !== -1) {
    key = args[ki + 1] ?? 'default';
    args.splice(ki, 2);
  }
  const reset = args.includes('--reset');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('usage: status-delta.mjs <status-file> [--key <name>] [--reset]\n');
    process.exit(2);
  }
  let cur = '';
  try {
    cur = readFileSync(file, 'utf8');
    const root = findRoot();
    const dir = stateDir(root, loadConfig(root));
    const snap = `${dir}/status-${key.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
    if (reset) {
      rmSync(snap, { force: true });
      process.stdout.write('status snapshot cleared\n');
      return;
    }
    let prev = null;
    let prevTime = null;
    try {
      prev = readFileSync(snap, 'utf8');
      prevTime = statSync(snap).mtime;
    } catch {
      // first run
    }
    ensureDir(dir);
    if (prev === null) {
      process.stdout.write(cur);
    } else {
      const lines = delta(prev, cur);
      if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
      else {
        const hh = String(prevTime.getHours()).padStart(2, '0');
        const mm = String(prevTime.getMinutes()).padStart(2, '0');
        process.stdout.write(`no change since ${hh}:${mm}\n`);
      }
    }
    writeFileSync(snap, cur);
  } catch {
    try {
      process.stdout.write(cur || readFileSync(file, 'utf8'));
    } catch {
      // nothing to print
    }
  }
}

if (isMain(import.meta.url)) main();
