#!/usr/bin/env node
// scripts/agents/log-round.mjs - write and read a build log without reading it whole.
//
// A build log (<handoff>/<feature>-build-log.md) has a `## Packets` table and a
// `## Round journal` of `### <packet>, round <r> (<YYYY-MM-DD>)` sections with `- ` bullets.
//
// Write (updates the packet's table row, or adds it, then appends a journal entry):
//
//   node scripts/agents/log-round.mjs --log <path> --packet NF-A8 --round 2 \
//     --verdict ITERATE --summary "Review (opus): ITERATE — BLOCKING 1 …" [options]
//
//   --log <path>         the build log (required)
//   --packet <id>        the packet, as in the table's first column (required)
//   --round <n>          the round; also sets the Round(s) column, if the table has one, unless --rounds is given
//   --date <YYYY-MM-DD>  the journal date (default: today, local time)
//   --summary "<text>"   one journal bullet (repeatable; each becomes a `- ` line)
//   --gate-log <path>    the log of the full verify run: adds a "Full verify" bullet with its exit status,
//                        test totals ("Tests:" / "Test Suites:" lines) and path, and fills the verify
//                        cell unless --gate is given. --gate-exit <n> states the exit code outright;
//                        without it a "make: *** Error n" line, or "all checks passed", decides.
//   Table cells (only the ones given change; a new row gets "—" elsewhere):
//   --base <sha>  --builder <who>  --rounds <n>  --gate <text>  --verdict <PROCEED|ITERATE|BLOCKED>
//   --findings <"B/SF">  --hard-rule <text>  --scope <text>  --honest <yes|no|…>  --notes <text>
//   --set "<Header>=<value>"  any column by its header text (repeatable)
//   --no-journal         update the table only
//
// Read (what the orchestrator reads instead of the whole file):
//
//   node scripts/agents/log-round.mjs --log <path> --show <packet> [--tail <n>]
//
// prints that packet's table row as `Header: value` lines, then the last <n> (default 40) lines.
// Writes print one confirmation line. A journal entry for a packet and round that already has a
// heading is appended to that section; otherwise a new section goes at the end of the Round journal.
// The table is re-padded so the columns line up. The verify cell is the first column whose header
// contains "verify", "gate" or "check" (any case). Column names for the other flags can be
// changed in agents.config.json under harness.buildLog.columns, e.g. {"verdict": "Result"}.
// Exit codes: 0 ok, 2 bad input. No dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import { findRoot, get, loadConfig } from '../hooks/lib/common.mjs';

const CELL_FLAGS = {
  base: 'Base',
  builder: 'Builder',
  rounds: 'Round',
  gate: null, // resolved from the header: verify | gate | check
  verdict: 'Verdict',
  findings: 'Findings',
  'hard-rule': 'Hard-rule breaks',
  scope: 'Scope',
  honest: 'Honesty',
  notes: 'Notes',
};
const COLUMNS = { ...CELL_FLAGS, ...get(loadConfig(findRoot()), 'harness.buildLog.columns', {}) };
const REPEATABLE = new Set(['summary', 'set']);
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const print = (s) => process.stdout.write(`${s}\n`);
const BOOLEAN = new Set(['no-journal']);

function fail(message) {
  console.error(`log-round: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { summary: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument '${a}'`);
    const key = a.slice(2);
    if (BOOLEAN.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`${a} needs a value`);
    if (REPEATABLE.has(key)) args[key].push(value);
    else args[key] = value;
  }
  return args;
}

// Split a `| a | b \| c |` row into trimmed cells, keeping escaped pipes.
function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (body[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += body[i];
  }
  cells.push(cur.trim());
  return cells;
}

const width = (s) => [...s].length;

function formatTable(rows) {
  const cols = rows[0].length;
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...rows.map((r, i) => (i === 1 ? 3 : width(r[c] ?? '')))),
  );
  return rows.map((r, i) =>
    i === 1
      ? `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`
      : `| ${widths.map((w, c) => (r[c] ?? '') + ' '.repeat(w - width(r[c] ?? ''))).join(' | ')} |`,
  );
}

// The packet table: the first table after `## Packets` whose header starts with `Packet`.
function findTable(lines) {
  const section = lines.findIndex((l) => /^##\s+Packets\b/.test(l));
  const from = section === -1 ? 0 : section;
  for (let i = from; i < lines.length - 1; i++) {
    if (/^\|\s*Packet\s*\|/.test(lines[i]) && /^\|\s*:?-{3,}/.test(lines[i + 1])) {
      let end = i + 2;
      while (end < lines.length && lines[end].trim().startsWith('|')) end++;
      return { start: i, end };
    }
  }
  fail('no packet table (a `| Packet | …` table under `## Packets`) in the log');
}

function gateBullet(path, exitArg) {
  let text;
  try {
    text = readFileSync(path, 'utf8').replace(ANSI, '');
  } catch {
    fail(`cannot read --gate-log ${path}`);
  }
  const lines = text.split('\n');
  const tests = lines.filter((l) => /(^|[\s:])Tests:\s/.test(l)).pop();
  const suites = lines.filter((l) => /(^|[\s:])Test Suites:\s/.test(l)).pop();
  const makeErr = lines.filter((l) => /make: \*\*\* .* Error \d+/.test(l)).pop();
  const steps = lines.map((l) => l.match(/^=== (.*) ===$/)?.[1]).filter(Boolean);
  const passed = /all checks passed/i.test(text);
  const clip = (l) =>
    l
      .replace(/^.*?(Test Suites|Tests):\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  let status;
  if (exitArg !== undefined) status = `exit ${exitArg}`;
  else if (passed) status = 'exit 0';
  else if (makeErr)
    status = `exit ${makeErr.match(/Error (\d+)/)[1]} at ${steps.at(-1) ?? 'an unnamed step'}`;
  else status = steps.length ? `stopped after ${steps.at(-1)}` : 'exit unknown (see log)';
  const parts = [status];
  if (suites) parts.push(`suites ${clip(suites)}`);
  if (tests) parts.push(`tests ${clip(tests)}`);
  return {
    cell: parts.join('; '),
    bullet: `Full verify: ${parts.join('; ')}; log \`${path}\``,
  };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function show(lines, table, packet, tail) {
  const header = splitRow(lines[table.start]);
  const row = lines.slice(table.start + 2, table.end).find((l) => splitRow(l)[0] === packet);
  if (row) {
    const cells = splitRow(row);
    header.forEach((h, i) => print(`${h}: ${cells[i] ?? ''}`));
  } else print(`(no table row for ${packet})`);
  print(`--- last ${tail} lines ---`);
  const body = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  if (tail > 0) print(body.slice(-tail).join('\n'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.log) fail('--log <path> is required');
  let text;
  try {
    text = readFileSync(args.log, 'utf8');
  } catch {
    fail(`cannot read ${args.log}`);
  }
  let lines = text.split('\n');
  const table = findTable(lines);

  if (args.show !== undefined) {
    const tail = Number(args.tail ?? 40);
    if (!Number.isInteger(tail) || tail < 0) fail('--tail must be a whole number');
    show(lines, table, args.show, tail);
    return;
  }

  const packet = args.packet;
  if (!packet) fail('--packet is required');
  if (args.round !== undefined && !/^\d+$/.test(args.round)) fail('--round must be a number');
  const journal = !args['no-journal'];
  if (journal && args.round === undefined)
    fail('--round is required for a journal entry (or pass --no-journal)');

  // 1. The table row.
  const rows = lines.slice(table.start, table.end).map(splitRow);
  const header = rows[0];
  const updates = new Map();
  const gateCol = header.find((h) => /verify|gate|check/i.test(h)) ?? 'Verify';
  for (const [flag, name] of Object.entries(COLUMNS))
    if (args[flag] !== undefined) updates.set(name ?? gateCol, args[flag]);
  const implicitRound = args.rounds === undefined && args.round !== undefined;
  if (implicitRound && header.some((h) => /^rounds?$/i.test(h.replace(/`/g, '').trim()))) updates.set(COLUMNS.rounds, args.round);
  let gate;
  if (args['gate-log']) {
    gate = gateBullet(args['gate-log'], args['gate-exit']);
    if (args.gate === undefined) updates.set(gateCol, gate.cell);
  }
  for (const pair of args.set) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`--set needs "<Header>=<value>", got '${pair}'`);
    updates.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  // Match header names without backticks and ignoring case.
  const key = (h) => h.replace(/`/g, '').trim().toLowerCase();
  for (const [col, value] of [...updates]) {
    const real = header.find((h) => key(h) === key(col)) ?? header.find((h) => key(h).startsWith(key(col)));
    if (real && real !== col) {
      updates.delete(col);
      updates.set(real, value);
    }
  }
  for (const col of updates.keys())
    if (!header.includes(col)) fail(`no column '${col}' (columns: ${header.join(', ')})`);

  const esc = (v) =>
    String(v)
      .replace(/\r?\n/g, ' ')
      .replace(/(?<!\\)\|/g, '\\|');
  let row = rows.slice(2).find((r) => r[0] === packet);
  const added = !row;
  if (added) {
    row = header.map(() => '—');
    row[0] = packet;
    rows.push(row);
  }
  for (const [col, value] of updates) row[header.indexOf(col)] = esc(value);
  lines.splice(table.start, table.end - table.start, ...formatTable(rows));

  // 2. The journal entry.
  let where = 'no journal entry';
  if (journal) {
    const bullets = [...args.summary];
    if (gate) bullets.push(gate.bullet);
    if (args.verdict && !bullets.some((b) => b.includes(args.verdict)))
      bullets.push(`Verdict: **${args.verdict}**`);
    if (!bullets.length) fail('a journal entry needs --summary, --gate-log or --verdict');
    const entry = bullets.map((b) => `- ${b.replace(/\r?\n/g, ' ').trim()}`);

    const jStart = lines.findIndex((l) => /^##\s+Round journal\b/.test(l));
    if (jStart === -1) fail('no `## Round journal` section in the log');
    let jEnd = lines.findIndex((l, i) => i > jStart && /^##\s/.test(l));
    if (jEnd === -1) jEnd = lines.length;
    const escRe = packet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headRe = new RegExp(`^###\\s+${escRe},\\s+round\\s+${args.round}\\b`);
    const head = lines.findIndex((l, i) => i > jStart && i < jEnd && headRe.test(l));

    // Insert after the last non-blank line of the target range.
    const insertAfterContent = (from, to, block) => {
      let at = to;
      while (at > from + 1 && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, ...block);
    };
    if (head !== -1) {
      let secEnd = lines.findIndex((l, i) => i > head && i < jEnd && /^###?\s/.test(l));
      if (secEnd === -1) secEnd = jEnd;
      insertAfterContent(head, secEnd, entry);
      where = `appended to "${lines[head]}"`;
    } else {
      const heading = `### ${packet}, round ${args.round} (${args.date ?? today()})`;
      insertAfterContent(jStart, jEnd, ['', heading, '', ...entry]);
      where = `new section "${heading}"`;
    }
  }

  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  writeFileSync(args.log, out);
  print(
    `log-round: ${packet} row ${added ? 'added' : 'updated'} (${[...updates.keys()].join(', ') || 'no cells'}); ${where}`,
  );
}

main();
