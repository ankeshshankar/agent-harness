#!/usr/bin/env node
// scripts/agents/queue-brief.mjs - queue every packet of a build brief, with dependencies.
//
//   node scripts/agents/queue-brief.mjs <brief-path> [--dry-run] [--include ID[,ID]]
//
// Reads the brief's packets (`### <ID>. <title>` under the PACKETS H2, the same rule as packet-slice.mjs)
// and appends one line per packet to the queue file that scripts/hooks/packet-runner.mjs reads
// (<stateDir>/queue.txt, or harness.queueFile / AGENT_HARNESS_QUEUE):
//
//   <brief-path> <packet> [after=ID[,ID]]
//
// Dependencies: a packet's own `Depends on:` line wins (`none` = no deps); otherwise the "Depends on"
// column of a packet table (first column = packet id). Only ids that are packets of this brief count;
// text in a `(... ‖ ...)` group is "parallel with", not a dependency. A value that is not none/empty and
// names no packet id ("every swap") means ALL earlier packets of the brief; a value that mixes ids and
// prose uses the ids and prints a warning. If the brief declares no dependencies at all, the packets
// form a serial chain (each after the previous one).
//
// Skipped: packets whose row in <feature>-build-log.md (the `## Packets` table, Verdict column) says
// PROCEED or COMMITTED, and packets already queued or running. Held (not queued): packets whose
// spec_status (the slice file if present, else the spec's frontmatter `status`) is not `approved`, and
// every packet that depends on a held one. A build-log verdict that is neither done nor empty or
// "not started" (building, ITERATE, BLOCKED, ...) is also held and reported as
// `? <ID> build log says '<verdict>' - confirm before queueing`; --include ID[,ID] queues those anyway
// once you have confirmed.
// The plan is printed in both modes; real mode also prints the lines appended. --dry-run writes nothing.
// The append takes the runner's lock and writes through a temp file and a rename.
//
// Exit codes: 0 ok, 1 usage or lock busy, 2 bad input.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, findRoot, get, loadConfig, stateDir } from '../hooks/lib/common.mjs';
import { acquire, release } from '../hooks/lib/lock.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function die(msg, code = 2) {
  console.error(`queue-brief: ${msg}`);
  process.exit(code);
}

function acquireWait(lock) {
  for (let i = 0; i < 50; i += 1) {
    if (acquire(lock)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

// ---- brief parsing

function frontmatter(lines) {
  const front = {};
  let body = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      for (const l of lines.slice(1, close)) {
        const m = /^([\w-]+):\s*(.*)$/.exec(l);
        if (m) front[m[1]] = m[2];
      }
      body = close + 1;
    }
  }
  return { front, body };
}

function headingsOf(lines, from) {
  const out = [];
  let fence = false;
  for (let i = from; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6}) (.*)$/.exec(lines[i]);
    if (m) out.push({ level: m[1].length, title: m[2].trim(), start: i });
  }
  return out;
}

function packetsOf(lines, body) {
  const hs = headingsOf(lines, body);
  const idx = hs.findIndex((h) => h.level === 2 && /PACKETS/.test(h.title));
  if (idx === -1) throw new Error('no "PACKETS" H2 in the brief');
  const next = hs.slice(idx + 1).find((h) => h.level <= 2);
  const endH2 = next ? next.start : lines.length;
  const out = [];
  for (let k = idx + 1; k < hs.length; k += 1) {
    const h = hs[k];
    if (h.start >= endH2) break;
    if (h.level !== 3) continue;
    const m = /^([A-Za-z0-9][\w-]*)\.\s/.exec(h.title);
    if (!m) continue;
    const stop = hs.slice(k + 1).find((x) => x.level <= 3);
    out.push({ id: m[1], title: h.title, start: h.start, end: Math.min(stop ? stop.start : lines.length, endH2) });
  }
  return out;
}

// plain name of a packet: its `- **Name:**` line (fallback: none)
function nameOf(lines, p) {
  for (let i = p.start + 1; i < p.end; i += 1) {
    const m = /^- \*\*Name:\*\*[ \t]*(.*)$/.exec(lines[i]);
    if (m) return m[1].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80).trim() || null;
  }
  return null;
}

function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const plain = (s) => s.replace(/[`*_]/g, '').trim();

// table rows: packet id -> text of the "Depends on" cell
function tableDeps(lines, body) {
  const map = new Map();
  let fence = false;
  for (let i = body; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence || !lines[i].startsWith('|')) continue;
    const head = cellsOf(lines[i]);
    const col = head.findIndex((c) => /^depends on$/i.test(plain(c)));
    if (col === -1 || !lines[i + 1] || !/^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) continue;
    let j = i + 2;
    for (; j < lines.length && lines[j].startsWith('|'); j += 1) {
      const row = cellsOf(lines[j]);
      const id = plain(row[0] || '');
      if (ID_RE.test(id) && col < row.length && !map.has(id)) map.set(id, row[col]);
    }
    i = j - 1;
  }
  return map;
}

// ids of this brief named in text (parallel groups ignored) + the prose left over
function idsInText(text, known) {
  const cleaned = text.replace(/\([^()]*‖[^()]*\)/g, ' ');
  const found = [];
  let rest = cleaned;
  for (const id of [...known].sort((a, b) => b.length - a.length)) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w-])${esc}(?![\\w-])(?!\\.\\w)`, 'g');
    if (re.test(cleaned)) found.push(id);
    rest = rest.replace(re, ' ');
  }
  const prose = plain(rest)
    .replace(/\b(and|or|plus|with|then)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return { found, prose };
}

const isNoneDep = (text) => {
  const t = plain(text);
  return t === '' || /^(none|n\/a|—|–|-)(?![\w])/i.test(t);
};

function declaredDeps(lines, packets, body) {
  const known = new Set(packets.map((p) => p.id));
  const table = tableDeps(lines, body);
  const deps = new Map();
  const warnings = [];
  let declared = false;
  packets.forEach((p, n) => {
    let text = null;
    for (let i = p.start + 1; i < p.end; i += 1) {
      const m = /^\s*(?:[-*]\s+)?\**Depends on:?\**:?\s*(.*)$/i.exec(lines[i]);
      if (m) {
        text = m[1];
        break;
      }
    }
    if (text == null && table.has(p.id)) text = table.get(p.id);
    if (text == null) {
      deps.set(p.id, null);
      return;
    }
    declared = true;
    const { found, prose } = idsInText(text, known);
    const ids = found.filter((d) => d !== p.id);
    if (found.length) {
      if (prose) warnings.push(`~ ${p.id} Depends on mixes packet ids and prose, using the ids (${ids.join(',') || 'none'}): '${plain(text)}'`);
      deps.set(p.id, ids);
    } else if (isNoneDep(text)) {
      deps.set(p.id, []);
    } else {
      warnings.push(`~ ${p.id} Depends on names no packet id, treating as all earlier packets: '${plain(text)}'`);
      deps.set(p.id, packets.slice(0, n).map((q) => q.id));
    }
  });
  return { deps, declared, warnings };
}

function specStatus(root, briefAbs, front, feature, packet) {
  try {
    const slice = path.join(path.dirname(briefAbs), feature, `${packet}.md`);
    const head = fs.readFileSync(slice, 'utf8').split('\n').slice(0, 30);
    const l = head.find((x) => /^spec_status:/.test(x));
    if (l) return l.replace(/^spec_status:\s*/, '').trim().split(/\s+/)[0] || 'missing';
  } catch {}
  const specRel = (front.spec || '').split(/\s+/)[0];
  if (!specRel) return 'missing';
  try {
    const lines = fs.readFileSync(path.join(root, specRel), 'utf8').split('\n');
    const { front: sf } = frontmatter(lines);
    return (sf.status || 'missing').replace(/^["']|["']$/g, '').split(/\s+/)[0] || 'missing';
  } catch {
    return 'missing';
  }
}

// Build-log table (`## Packets`, Verdict column): done = PROCEED/COMMITTED; other = anything that is
// neither done nor empty / "not started" (id -> raw verdict).
function logStates(logPath) {
  const done = new Set();
  const other = new Map();
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return { done, other };
  }
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => /^##\s+Packets\s*$/i.test(l.trim()));
  if (at === -1) return { done, other };
  let col = -1;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    if (!lines[i].startsWith('|')) continue;
    const cells = cellsOf(lines[i]);
    if (col === -1) {
      col = cells.findIndex((c) => /^verdict$/i.test(plain(c)));
      continue;
    }
    if (/^[\s:|-]+$/.test(lines[i])) continue;
    const id = plain(cells[0] || '');
    if (!ID_RE.test(id) || col >= cells.length) continue;
    const verdict = plain(cells[col]);
    if (/\b(PROCEED|COMMITTED)\b/i.test(verdict)) done.add(id);
    else if (!/^(|not started|—|–|-|n\/a)$/i.test(verdict)) other.set(id, verdict);
  }
  return { done, other };
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  } catch {
    return [];
  }
}

function queuedIds(queueFile) {
  const ids = new Set();
  for (const l of readLines(queueFile)) {
    const p = l.trim().split(/\s+/)[1];
    if (p) ids.add(p);
  }
  return ids;
}

function runningIds(dir) {
  const ids = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'packets.json'), 'utf8'));
    if (Array.isArray(data)) for (const r of data) if (r && r.status === 'running' && r.packet) ids.add(r.packet);
  } catch {
    // no state yet
  }
  return ids;
}

function main(argv) {
  const dry = argv.includes('--dry-run');
  const include = new Set();
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') continue;
    if (a === '--include' || a.startsWith('--include=')) {
      const v = a === '--include' ? argv[(i += 1)] : a.slice('--include='.length);
      if (!v || v.startsWith('-')) die('--include needs packet ids, e.g. --include A-1,A-2', 1);
      for (const id of v.split(',')) if (id.trim()) include.add(id.trim());
      continue;
    }
    args.push(a);
  }
  if (args.length !== 1 || args[0].startsWith('-')) die('usage: queue-brief.mjs <brief-path> [--dry-run] [--include ID[,ID]]', 1);

  const root = fs.realpathSync(findRoot());
  const cfg = loadConfig(root);
  let briefAbs = path.resolve(args[0]);
  try {
    briefAbs = fs.realpathSync(briefAbs);
  } catch {
    // a missing brief is reported below
  }
  const brief = path.relative(root, briefAbs).split(path.sep).join('/');
  if (brief.startsWith('..')) die('the brief must be inside the project');
  if (/\s/.test(brief)) die('the brief path must not contain whitespace');
  let lines;
  try {
    lines = fs.readFileSync(briefAbs, 'utf8').split('\n');
  } catch {
    die(`brief not found: ${brief}`);
  }
  const base = path.basename(brief);
  if (!base.endsWith('-build-brief.md')) die('brief must be named <feature>-build-brief.md');
  const feature = base.slice(0, -'-build-brief.md'.length);
  const { front, body } = frontmatter(lines);
  let packets;
  try {
    packets = packetsOf(lines, body);
  } catch (e) {
    die(e.message);
  }
  if (!packets.length) die('no packets found');
  for (const p of packets) if (!ID_RE.test(p.id)) die(`bad packet id ${p.id}`);
  for (const id of include) if (!packets.some((p) => p.id === id)) die(`--include: ${id} is not a packet of this brief`);

  const { deps, declared, warnings } = declaredDeps(lines, packets, body);
  const { done, other } = logStates(path.join(path.dirname(briefAbs), `${feature}-build-log.md`));
  const sdir = stateDir(root, cfg);
  const runDir = path.join(sdir, 'state');
  const queueFile = process.env.AGENT_HARNESS_QUEUE || get(cfg, 'harness.queueFile', path.join(sdir, 'queue.txt'));
  const qpath = path.isAbsolute(queueFile) ? queueFile : path.join(root, queueFile);
  const already = new Set([...queuedIds(qpath), ...runningIds(runDir)]);

  const names = new Map(packets.map((p) => [p.id, nameOf(lines, p)]));
  const lab = (id) => (names.get(id) ? `${names.get(id)} (${id})` : id);
  const plan = { queued: [], done: [], held: [], heldDeps: [], already: [], unconfirmed: [] };
  const state = new Map(); // id -> 'queued'|'done'|'held'|'heldDep'|'already'
  let prev = null;
  for (const p of packets) {
    let want = deps.get(p.id);
    if (!declared) want = prev ? [prev] : [];
    else if (want == null) want = [];
    prev = p.id;

    if (done.has(p.id)) {
      state.set(p.id, 'done');
      plan.done.push(lab(p.id));
      continue;
    }
    if (already.has(p.id)) {
      state.set(p.id, 'already');
      plan.already.push(lab(p.id));
      continue;
    }
    if (other.has(p.id) && !include.has(p.id)) {
      state.set(p.id, 'held');
      plan.unconfirmed.push(`? ${lab(p.id)} build log says '${other.get(p.id)}' - confirm before queueing`);
      continue;
    }
    const status = specStatus(root, briefAbs, front, feature, p.id);
    if (status !== 'approved') {
      state.set(p.id, 'held');
      plan.held.push(`${lab(p.id)} (spec_status ${status})`);
      continue;
    }
    const heldOn = want.filter((d) => state.get(d) === 'held' || state.get(d) === 'heldDep');
    if (heldOn.length) {
      state.set(p.id, 'heldDep');
      plan.heldDeps.push(`${lab(p.id)} (after ${heldOn.map(lab).join(', ')})`);
      continue;
    }
    const after = want.filter((d) => state.get(d) !== 'done'); // done deps are satisfied
    state.set(p.id, 'queued');
    plan.queued.push({ id: p.id, after });
  }

  const out = [...warnings];
  out.push(`${dry ? 'plan (dry run)' : 'plan'}: ${brief}${declared ? '' : ' (no deps declared: serial chain)'}`);
  for (const q of plan.queued) out.push(`  + ${lab(q.id)}${q.after.length ? ` after=${q.after.map(lab).join(', ')}` : ''}`);
  if (!plan.queued.length) out.push('  (nothing to queue)');
  out.push(...plan.unconfirmed);
  if (plan.done.length) out.push(`skipped, done in build log: ${plan.done.join(', ')}`);
  if (plan.already.length) out.push(`skipped, already queued/running: ${plan.already.join(', ')}`);
  if (plan.held.length) out.push(`held, spec not approved: ${plan.held.join(', ')}`);
  if (plan.heldDeps.length) out.push(`held, depends on a held packet: ${plan.heldDeps.join('; ')}`);

  if (!dry && plan.queued.length) {
    ensureDir(runDir);
    ensureDir(path.dirname(qpath));
    const lock = path.join(runDir, 'packets.lock');
    if (!acquireWait(lock)) die('queue lock is busy; try again', 1);
    try {
      // Re-check under the lock so two callers cannot queue the same packet twice.
      const nowQueued = queuedIds(qpath);
      const fresh = plan.queued.filter((q) => !nowQueued.has(q.id));
      let cur = '';
      try {
        cur = fs.readFileSync(qpath, 'utf8');
      } catch {
        // no queue file yet
      }
      if (cur && !cur.endsWith('\n')) cur += '\n';
      const add = fresh.map((q) => `${brief} ${q.id}${q.after.length ? ` after=${q.after.join(',')}` : ''}`);
      const tmp = `${qpath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, cur + add.map((l) => `${l}\n`).join(''));
      fs.renameSync(tmp, qpath);
      out.push(`appended to ${path.relative(root, qpath) || qpath}:`);
      for (const l of add) out.push(`  ${l}`);
      if (fresh.length !== plan.queued.length) out.push(`(${plan.queued.length - fresh.length} already queued meanwhile)`);
    } finally {
      release(lock);
    }
  }
  console.log(out.join('\n'));
}

main(process.argv.slice(2));
