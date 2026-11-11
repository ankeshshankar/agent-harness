#!/usr/bin/env node
// scripts/hooks/packet-runner.mjs - run queued packets, one detached headless session each.
//
//   node scripts/hooks/packet-runner.mjs                 SessionStart hook: report finished runs, start the next
//   node scripts/hooks/packet-runner.mjs --chain <exit>  used by the runner itself: start the next when one ends
//   node scripts/hooks/packet-runner.mjs --status        print the queue and the runs
//   node scripts/hooks/packet-runner.mjs --pause [why]   stop starting packets
//   node scripts/hooks/packet-runner.mjs --resume        start again
//
// The queue is a text file you own: <stateDir>/queue.txt (harness.queueFile / AGENT_HARNESS_QUEUE).
// One line per packet:   <brief-path> <packet-id> [after=ID[,ID]]     ("#" starts a comment)
// The brief path is relative to the project root. Add lines by hand or with scripts/agents/queue-brief.mjs.
//
// Flow. A session start (or a chain call) takes the lock, reconciles finished runs, and starts the
// first runnable line with `scripts/agents/run-packet.sh <brief> <packet> --worktree [--base ..] [--merge ..]`
// in a detached shell. When that run exits, the same shell calls `--chain`, which starts the next one:
// chain on success. A line is runnable when every `after=` packet is done. A failed packet blocks its
// dependents. With pauseOnFailure (default on) a failed run also writes <stateDir>/state/queue.paused,
// so nothing else starts until you run `--resume` (or delete that file): pause on failure.
// A done dependency's branch (the `BRANCH <name>` line in its log) is passed on as --base / --merge.
// The source-compact SessionStart event, and runs inside a packet session, do nothing.
//
// Config (agents.config.json, key "harness.queue"): maxConcurrent (default 1, at most 4; above 1 only
// while memory pressure is normal), pauseOnFailure (default true).
// Env: AGENT_HARNESS_QUEUE (queue file), AGENT_HARNESS_QUEUE_MAX, AGENT_HARNESS_PAUSE_ON_FAILURE=0|1,
// AGENT_HARNESS_RUN_PACKET (path of run-packet.sh), AGENT_HARNESS_QUEUE_HOOK=off (disable the hook),
// AGENT_HARNESS_TEST=1 with AGENT_HARNESS_RUNNER_CMD (tests only: replaces run-packet.sh).
// State (git-ignored): <stateDir>/state/{packets.json,packets.lock,queue.paused}, <stateDir>/packet-logs/.
// Exit code: always 0 (a failure writes <stateDir>/state/packet-runner.err and stays silent).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, findRoot, get, isMain, loadConfig, numEnv, stateDir } from './lib/common.mjs';
import { acquire, release } from './lib/lock.mjs';
import { pressure } from './lib/memory.mjs';

const SELF = fileURLToPath(import.meta.url);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function ctx() {
  const root = findRoot();
  const cfg = loadConfig(root);
  const base = stateDir(root, cfg);
  const queueFile = process.env.AGENT_HARNESS_QUEUE || get(cfg, 'harness.queueFile', path.join(base, 'queue.txt'));
  return {
    root,
    cfg,
    base,
    dir: path.join(base, 'state'),
    logs: path.join(base, 'packet-logs'),
    queue: path.isAbsolute(queueFile) ? queueFile : path.join(root, queueFile),
  };
}

function maxConcurrent(c) {
  let n = Math.floor(numEnv('AGENT_HARNESS_QUEUE_MAX', get(c.cfg, 'harness.queue.maxConcurrent', 1)));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 4) n = 4;
  if (n > 1 && pressure().level !== 'normal') n = 1;
  return n;
}

function pauseOnFailure(c) {
  const env = process.env.AGENT_HARNESS_PAUSE_ON_FAILURE;
  if (env === '0') return false;
  if (env === '1') return true;
  return get(c.cfg, 'harness.queue.pauseOnFailure', true) !== false;
}

function failOpen(c, err) {
  try {
    ensureDir(c.dir);
    fs.writeFileSync(path.join(c.dir, 'packet-runner.err'), `${err?.stack || err}\n`);
  } catch {
    // nowhere to write
  }
  process.exit(0);
}

// ---- state --------------------------------------------------------------------------------

export function loadState(dir, repair) {
  const p = path.join(dir, 'packets.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('state is not an array');
    return data;
  } catch {
    if (!repair) return [];
    fs.rmSync(`${p}.bad`, { force: true });
    fs.renameSync(p, `${p}.bad`);
    return [];
  }
}

function saveState(dir, state) {
  const p = path.join(dir, 'packets.json');
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, p);
}

// Keep the last 50 runs; never drop a running one.
function prune(state) {
  if (state.length <= 50) return state;
  const running = state.filter((r) => r.status === 'running');
  const finished = state.filter((r) => r.status !== 'running').slice(-(50 - running.length));
  const keep = new Set([...finished, ...running]);
  return state.filter((r) => keep.has(r));
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
};

function readExit(p) {
  try {
    const n = Number.parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readPart(logPath, tail) {
  let fd;
  try {
    const st = fs.statSync(logPath);
    if (!st.isFile() || st.size === 0) return null;
    const len = Math.min(st.size, 65_536);
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, tail ? st.size - len : 0);
    let text = buf.toString('utf8');
    if (tail && st.size > len) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function lastResult(logPath) {
  const text = readPart(logPath, true);
  if (!text) return null;
  let found = null;
  for (const line of text.split('\n')) if (line.trim().startsWith('RESULT')) found = line.trim();
  return found;
}

// The BRANCH line run-packet.sh prints early; head of the log only.
function logBranch(logPath) {
  const text = readPart(logPath, false);
  if (!text) return null;
  let found = null;
  for (const line of text.split('\n')) {
    const m = /^BRANCH (packet\/[A-Za-z0-9._/-]+)\s*$/.exec(line);
    if (m && !m[1].includes('..')) found = m[1];
  }
  return found;
}

// `done` = the run whose wrapper is alive only because it is calling chain mode.
// Returns the runs that finished as failed in this call.
export function reconcile(state, done = null) {
  const failed = [];
  for (const run of state) {
    if (run.status !== 'running') continue;
    if (run !== done && alive(run.pid)) continue;
    const code = readExit(run.exitPath);
    const line = run.logPath ? lastResult(run.logPath) : null;
    run.status = code === 0 ? 'done' : 'failed';
    run.result = line || `exit ${code == null ? '?' : code}`;
    if (run.logPath) run.branch = logBranch(run.logPath);
    if (run.status === 'failed') failed.push(run);
  }
  for (const run of state) {
    if (run.status === 'done' && run.branch === undefined && run.logPath) run.branch = logBranch(run.logPath);
  }
  return failed;
}

// ---- names and lines ------------------------------------------------------------------------

// The plain name of a packet: the `- **Name:**` line under its `### <id>. ` heading.
function briefName(root, brief, id) {
  try {
    if (!brief || !id || brief.startsWith('/') || brief.startsWith('-') || brief.split('/').includes('..')) return null;
    const head = `### ${id}. `;
    let on = false;
    for (const l of fs.readFileSync(path.join(root, brief), 'utf8').split('\n')) {
      if (!on) {
        on = l.startsWith(head);
        continue;
      }
      if (l.startsWith('#')) break;
      const m = /^- \*\*Name:\*\*[ \t]*(.*)$/.exec(l);
      if (m) {
        // eslint-disable-next-line no-control-regex
        return m[1].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80).trim() || null;
      }
    }
  } catch {
    // unreadable brief: bare id
  }
  return null;
}

const labelOf = (name, id) => (name ? `${name} (${id})` : String(id));
const runLabel = (c, run) =>
  labelOf(typeof run.name === 'string' ? run.name : briefName(c.root, run.brief, run.packet), run.packet);

function minutes(started) {
  const t = typeof started === 'number' ? started : Date.parse(String(started));
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 60_000)) : 0;
}

/** Parse one queue line: `<brief> <packet> [after=A,B]`. entry.bad names the problem. */
export function parseLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 2 && parts.length !== 3) {
    return { packet: (parts[1] || parts[0] || 'invalid').slice(0, 120), brief: parts[0] || '', after: [], bad: 'bad queue line' };
  }
  const entry = { brief: parts[0], packet: parts[1], after: [] };
  if (parts.length === 3) {
    const m = /^after=(.+)$/.exec(parts[2]);
    const ids = m ? m[1].split(',') : [];
    if (!m || !ids.every((d) => ID_RE.test(d) && d.length <= 120)) entry.bad = 'bad after field';
    else entry.after = [...new Set(ids)].filter((d) => d !== entry.packet);
  }
  if (!ID_RE.test(entry.packet)) {
    entry.packet = entry.packet.slice(0, 120);
    entry.bad = 'bad packet id';
  } else if (!entry.bad && (entry.brief.startsWith('/') || entry.brief.startsWith('-') || entry.brief.split('/').includes('..'))) {
    entry.bad = 'bad brief path';
  }
  return entry;
}

function runnerPath(c) {
  if (process.env.AGENT_HARNESS_TEST === '1' && process.env.AGENT_HARNESS_RUNNER_CMD) return process.env.AGENT_HARNESS_RUNNER_CMD;
  const fromEnv = process.env.AGENT_HARNESS_RUN_PACKET || get(c.cfg, 'harness.runPacket', '');
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(c.root, fromEnv);
  const inProject = path.join(c.root, 'scripts', 'agents', 'run-packet.sh');
  return fs.existsSync(inProject) ? inProject : path.join(path.dirname(SELF), '..', 'agents', 'run-packet.sh');
}

function invalidReason(c, entry) {
  if (entry.bad) return entry.bad;
  try {
    fs.accessSync(runnerPath(c), fs.constants.X_OK);
  } catch {
    return 'runner not executable';
  }
  try {
    if (!fs.statSync(path.join(c.root, entry.brief)).isFile()) return 'brief not found';
  } catch {
    return 'brief not found';
  }
  return null;
}

// ---- queue file -----------------------------------------------------------------------------

function readQueueLines(c) {
  try {
    return fs.readFileSync(c.queue, 'utf8').split('\n');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function writeQueueLines(c, lines) {
  const tmp = `${c.queue}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'));
  fs.renameSync(tmp, c.queue);
}

const isEntryLine = (l) => {
  const t = l.trim();
  return t && !t.startsWith('#');
};

function latestRun(state, id) {
  for (let i = state.length - 1; i >= 0; i -= 1) if (state[i].packet === id) return state[i];
  return null;
}

// -> { kind: 'ok', branches } | { kind: 'wait' } | { kind: 'blocked', root }
function classify(entry, qc, seen = new Set()) {
  const branches = [];
  let wait = false;
  let blockedBy = null;
  for (const dep of entry.after || []) {
    if (qc.invalid.has(dep)) {
      blockedBy ??= dep;
      continue;
    }
    const q = qc.queued.get(dep);
    if (q && q !== entry) {
      if (seen.has(dep)) {
        wait = true;
        continue;
      }
      const sub = classify(q, qc, new Set([...seen, entry.packet]));
      if (sub.kind === 'blocked') blockedBy ??= sub.root;
      else wait = true;
      continue;
    }
    const r = latestRun(qc.state, dep);
    if (!r) continue; // not queued, never run: counts as done earlier
    if (r.status === 'running') wait = true;
    else if (r.status === 'failed') blockedBy ??= dep;
    else if (r.status === 'done' && typeof r.branch === 'string' && r.branch) branches.push(r.branch);
  }
  if (blockedBy) return { kind: 'blocked', root: blockedBy };
  if (wait) return { kind: 'wait' };
  return { kind: 'ok', branches: [...new Set(branches)] };
}

function queueContext(c, lines, state) {
  const queued = new Map();
  const invalid = new Set();
  for (const l of lines) {
    if (!isEntryLine(l)) continue;
    const e = parseLine(l);
    if (invalidReason(c, e)) invalid.add(e.packet);
    else if (!queued.has(e.packet)) queued.set(e.packet, e);
  }
  return { state, queued, invalid };
}

function failedRecord(c, entry, reason) {
  return {
    packet: entry.packet,
    brief: entry.brief,
    name: entry.bad ? null : briefName(c.root, entry.brief, entry.packet),
    pid: null,
    started: Date.now(),
    logPath: null,
    exitPath: null,
    status: 'failed',
    result: reason,
    shown: false,
  };
}

// First runnable entry, removed from the queue file. Invalid lines reached on the way are dropped
// and recorded as failed. Waiting and blocked lines stay.
function takeRunnable(c, state) {
  const lines = readQueueLines(c);
  if (!lines) return null;
  const qc = queueContext(c, lines, state);
  const out = [];
  let picked = null;
  let changed = false;
  for (const l of lines) {
    if (picked || !isEntryLine(l)) {
      out.push(l);
      continue;
    }
    const entry = parseLine(l);
    const reason = invalidReason(c, entry);
    if (reason) {
      state.push(failedRecord(c, entry, reason));
      changed = true;
      continue;
    }
    const k = classify(entry, qc);
    if (k.kind === 'ok') {
      picked = entry;
      picked.branches = k.branches;
      changed = true;
      continue;
    }
    out.push(l);
  }
  if (changed) writeQueueLines(c, out);
  return picked;
}

function blockedEntries(c, state) {
  const lines = readQueueLines(c);
  if (!lines) return [];
  const qc = queueContext(c, lines, state);
  const res = [];
  for (const l of lines) {
    if (!isEntryLine(l)) continue;
    const e = parseLine(l);
    if (invalidReason(c, e)) continue;
    const k = classify(e, qc);
    if (k.kind === 'blocked') {
      const dr = latestRun(state, k.root);
      res.push({
        packet: e.packet,
        name: briefName(c.root, e.brief, e.packet),
        dep: k.root,
        depName: dr && typeof dr.name === 'string' ? dr.name : briefName(c.root, e.brief, k.root),
      });
    }
  }
  return res;
}

function validQueued(c) {
  let n = 0;
  for (const l of readQueueLines(c) ?? []) if (isEntryLine(l) && !invalidReason(c, parseLine(l))) n += 1;
  return n;
}

// ---- pause ----------------------------------------------------------------------------------

const pausePath = (c) => path.join(c.dir, 'queue.paused');

function readPause(c) {
  try {
    const first = fs.readFileSync(pausePath(c), 'utf8').split('\n')[0].trim();
    return { why: first || '?' };
  } catch {
    return null;
  }
}

function writePause(c, why) {
  ensureDir(c.dir);
  fs.writeFileSync(pausePath(c), `${why}\n`);
}

// ---- launch ---------------------------------------------------------------------------------

const shQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
const safeName = (p) => String(p).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'packet';

function launch(c, entry) {
  const branches = Array.isArray(entry.branches) ? entry.branches : [];
  const flags = branches.length ? ['--base', branches[0], ...branches.slice(1).flatMap((b) => ['--merge', b])] : [];
  ensureDir(c.logs);
  const stamp = Date.now();
  const logPath = path.join(c.logs, `${safeName(entry.packet)}-${stamp}.log`);
  const exitPath = path.join(c.logs, `${safeName(entry.packet)}-${stamp}.exit`);
  // After the exit code is written, hand over to chain mode (positional args only).
  const script =
    'b=$1; p=$2; l=$3; x=$4; c=$5; shift 5; ' +
    `${shQuote(runnerPath(c))} "$b" "$p" --worktree "$@" > "$l" 2>&1; echo $? > "$x"; ` +
    `env -u AGENT_HARNESS_PACKET_CHILD ${shQuote(process.execPath)} ${shQuote(SELF)} --chain "$c" </dev/null >/dev/null 2>&1`;
  const child = spawn('/bin/bash', ['-c', script, 'pr', entry.brief, entry.packet, logPath, exitPath, exitPath, ...flags], {
    cwd: c.root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_HARNESS_PACKET_CHILD: '1', AGENT_HARNESS_ROOT: c.root },
  });
  child.on('error', () => {});
  child.unref();
  return {
    packet: entry.packet,
    brief: entry.brief,
    name: briefName(c.root, entry.brief, entry.packet),
    pid: child.pid ?? null,
    started: Date.now(),
    logPath,
    exitPath,
    status: 'running',
    result: null,
    branch: undefined,
    base: branches[0] ?? null,
    shown: false,
  };
}

function startQueued(c, state) {
  const started = [];
  let running = state.filter((r) => r.status === 'running').length;
  const max = maxConcurrent(c);
  while (running < max) {
    const entry = takeRunnable(c, state);
    if (!entry) break;
    const reason = invalidReason(c, entry);
    if (reason) {
      state.push(failedRecord(c, entry, reason));
      continue;
    }
    let rec;
    try {
      rec = launch(c, entry);
    } catch (e) {
      state.push(failedRecord(c, entry, `launch error: ${e?.message || e}`));
      continue;
    }
    state.push(rec);
    started.push(rec);
    running += 1;
  }
  return started;
}

function pauseIfFailed(c, failed) {
  if (failed.length && pauseOnFailure(c) && !readPause(c)) writePause(c, failed[failed.length - 1].packet);
}

// ---- entry points ---------------------------------------------------------------------------

function chain(c, exitPath) {
  ensureDir(c.dir);
  const lock = path.join(c.dir, 'packets.lock');
  if (!acquire(lock)) return;
  try {
    const state = loadState(c.dir, true);
    const fin = exitPath ? state.find((r) => r.exitPath === exitPath) : null;
    const failed = reconcile(state, fin && fin.status === 'running' ? fin : null);
    pauseIfFailed(c, failed);
    if (!readPause(c)) startQueued(c, state);
    saveState(c.dir, prune(state));
  } finally {
    release(lock);
  }
}

function emit(text) {
  process.stdout.write(`${JSON.stringify({ systemMessage: text, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`);
}

function report(c, readInput, mutate = true) {
  let event = {};
  if (readInput) {
    const raw = fs.readFileSync(0, 'utf8');
    event = raw.trim() ? JSON.parse(raw) : {};
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('bad session payload');
    if (event.source === 'compact') return null;
  }
  ensureDir(c.dir);
  const lock = path.join(c.dir, 'packets.lock');
  let locked = false;
  try {
    locked = mutate && acquire(lock);
    // Unlocked = read-only: report from an in-memory view, write nothing.
    const state = loadState(c.dir, locked);
    const failed = reconcile(state);
    if (locked) pauseIfFailed(c, failed);
    const finished = [];
    for (const rec of state) {
      if ((rec.status === 'done' || rec.status === 'failed') && rec.shown !== true) {
        finished.push(`${rec.status === 'done' ? 'done' : 'FAILED'} ${runLabel(c, rec)} ${rec.result ?? ''}${rec.logPath ? ` ${rec.logPath}` : ''}`.trim());
        if (locked) rec.shown = true;
      }
    }
    const paused = readPause(c);
    const started = locked && !paused ? startQueued(c, state) : [];
    const kept = locked ? prune(state) : state;
    if (locked) saveState(c.dir, kept);
    const lines = [];
    const just = new Set(started);
    for (const rec of kept) if (rec.status === 'running' && !just.has(rec)) lines.push(`running ${runLabel(c, rec)} ${minutes(rec.started)}m`);
    for (const rec of started) lines.push(`started ${runLabel(c, rec)}`);
    lines.push(...finished);
    for (const b of blockedEntries(c, kept)) lines.push(`waits: ${labelOf(b.name, b.packet)} needs FAILED ${labelOf(b.depName, b.dep)}`);
    if (paused) {
      const left = validQueued(c);
      if (left > 0) lines.push(`queue paused (${paused.why}) with ${left} left; run: node scripts/hooks/packet-runner.mjs --resume`);
    }
    return lines;
  } finally {
    if (locked) release(lock);
  }
}

function main() {
  const c = ctx();
  if (process.env.AGENT_HARNESS_PACKET_CHILD === '1') return;
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--chain') return chain(c, args[1] || '');
    if (args[0] === '--resume') {
      fs.rmSync(pausePath(c), { force: true });
      process.stdout.write('queue resumed\n');
      return chain(c, '');
    }
    if (args[0] === '--pause') {
      writePause(c, args.slice(1).join(' ') || 'manual');
      process.stdout.write('queue paused\n');
      return;
    }
    if (args[0] === '--status') {
      const lines = report(c, false, false) ?? [];
      process.stdout.write(`${lines.length ? lines.join('\n') : 'queue empty, nothing running'}\n`);
      return;
    }
    if (process.env.AGENT_HARNESS_QUEUE_HOOK === 'off') return;
    const lines = report(c, true);
    if (lines && lines.length) emit(lines.join('\n'));
  } catch (err) {
    failOpen(c, err);
  }
}

if (isMain(import.meta.url)) main();
