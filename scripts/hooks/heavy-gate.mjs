#!/usr/bin/env node
// scripts/hooks/heavy-gate.mjs - makes heavy jobs take turns so a laptop does not run out of memory.
//
//   node scripts/hooks/heavy-gate.mjs pre            PreToolUse, matcher Bash: wait for a turn, then register the job
//   node scripts/hooks/heavy-gate.mjs post           PostToolUse, matcher Bash: remove the job from the registry
//   node scripts/hooks/heavy-gate.mjs lane-pre <id> <pid>   wait for the lane for a script (scripts/bin/check-lane.sh)
//   node scripts/hooks/heavy-gate.mjs lane-post <id>        release it
//
// Two kinds of heavy command, judged on the program each part of the command runs (never on words
// it only mentions, so `grep jest x` is not heavy):
//   lane    whole-repo work: the config's verify and typecheck commands, a whole test run, tsc,
//           gradle, xcodebuild, cargo/go builds, make verify. One at a time, first come first served,
//           across every session that shares this project folder.
//   narrow  a test run that names files or a pattern: runs in parallel while memory pressure is normal.
// Memory pressure (scripts/hooks/lib/memory.mjs): normal = go (lane jobs still queue);
// warning = every heavy job takes turns; critical = hold up to criticalAloneSeconds when alone.
// No job waits longer than maxWaitSeconds in total, then it runs anyway. The hook never blocks:
// it prints nothing and always exits 0. It only delays.
//
// Config (agents.config.json, key "harness.heavy"):
//   lane      extra regexes (matched on one simple command) for lane jobs
//   narrow    extra regexes for narrow heavy jobs
//   maxWaitSeconds        default 1200
//   criticalAloneSeconds  default 300
// Env: AGENT_HARNESS_HEAVY_GATE=off disables; AGENT_HARNESS_MAX_WAIT_S, AGENT_HARNESS_CRITICAL_ALONE_S,
// AGENT_HARNESS_POLL_MS (default 5000) tune the waits; AGENT_HARNESS_FORCE_PRESSURE for tests.
// State: <stateDir>/lane/{jobs,queue}/ and <stateDir>/lane/gate.log (git-ignored). Skipped when CI is set.
// Exit code: always 0.
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileAll, ensureDir, findRoot, get, isMain, loadConfig, numEnv, readStdinJson, stateDir } from './lib/common.mjs';
import { pressure } from './lib/memory.mjs';

const FG_TTL_MS = 45 * 60 * 1000; // a foreground entry older than this is a lost PostToolUse
const BG_TTL_MS = 15 * 60 * 1000; // background jobs: PostToolUse fires at once, so count them for 15 min

const WRAP_RE =
  /^((\w+=\S*|time|nice|command|exec|caffeinate(\s+-\w+)*|timeout\s+\S+|npx(\s+--?\S+)*|pnpm\s+(exec|dlx)|bunx|(ba|z)?sh(\s+-[a-z]+)*)\s+)+/;
const LANE_DEFAULT = [
  /^(\.\/)?(tsc|gradlew|xcodebuild|mvn|gradle)(\s|$)/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(verify|typecheck|tsc|build)(\s|$)/,
  /^make\s+(verify|typecheck|build|check)(\s|$)/,
  /^cargo\s+(build|test|check|clippy)(\s|$)/,
  /^go\s+(build|test|vet)(\s|$)/,
];
const TEST_DEFAULT = [
  /^(jest|vitest|pytest|mocha)(\s|$)/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|jest|vitest)(\s|$)/,
  /^make\s+test(\s|$)/,
];
// A test run is narrow when it names files or a pattern; without one it is the whole suite.
const NARROW_RE =
  /(--findRelatedTests|--runTestsByPath|--testPathPatterns?|--testNamePattern|--onlyChanged|--changedSince|\s-t\s|\s-k\s|\S\.(test|spec)\.[jt]sx?\b|__tests__|\stests?\/\S|\s(src|apps|packages)\/\S)/;

/** { heavy, lane } for a shell command. cfg supplies commands.verify/typecheck and harness.heavy. */
export function classify(command, cfg = {}) {
  const extraLane = compileAll(get(cfg, 'harness.heavy.lane', []));
  const extraNarrow = compileAll(get(cfg, 'harness.heavy.narrow', []));
  const literal = ['verify', 'typecheck']
    .map((k) => get(cfg, `commands.${k}`, ''))
    .filter((v) => typeof v === 'string' && v.trim());
  let heavy = false;
  let lane = false;
  for (const raw of command.split(/&&|\|\||[;|\n(]/)) {
    const s = raw.trim().replace(/^["']+/, '').replace(WRAP_RE, '');
    if (!s) continue;
    const isLane = LANE_DEFAULT.some((r) => r.test(s)) || extraLane.some((r) => r.test(s)) || literal.some((l) => [s, raw.trim()].some((t) => t === l || t.startsWith(`${l} `)));
    const isTest = TEST_DEFAULT.some((r) => r.test(s)) || extraNarrow.some((r) => r.test(s));
    if (!isLane && !isTest) continue;
    heavy = true;
    if (isLane || !NARROW_RE.test(s)) lane = true;
  }
  return { heavy, lane };
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function paths(root, cfg) {
  const base = join(stateDir(root, cfg), 'lane');
  return { base, jobs: join(base, 'jobs'), queue: join(base, 'queue'), log: join(base, 'gate.log') };
}

/** Heavy jobs running now, other than selfId. Drops entries whose owner has gone. */
export function activeJobs(P, selfId, now = Date.now()) {
  if (!existsSync(P.jobs)) return [];
  const out = [];
  for (const f of readdirSync(P.jobs)) {
    const p = join(P.jobs, f);
    const job = readJson(p);
    if (!job) {
      rmSync(p, { force: true });
      continue;
    }
    const ttl = job.ownerPid ? 3 * 60 * 60 * 1000 : job.background ? BG_TTL_MS : FG_TTL_MS;
    const gone = (job.ownerPid && !alive(job.ownerPid)) || now - job.started > ttl;
    if (gone) rmSync(p, { force: true });
    else if (f !== `${selfId}.json`) out.push(job);
  }
  return out;
}

/** Lane tickets that asked before this one (first come, first served). */
export function laneAhead(P, selfId, t0) {
  let n = 0;
  for (const f of existsSync(P.queue) ? readdirSync(P.queue) : []) {
    if (f === `${selfId}.json`) continue;
    const p = join(P.queue, f);
    const q = readJson(p);
    if (!q || !alive(q.pid)) rmSync(p, { force: true });
    else if (q.t0 < t0 || (q.t0 === t0 && f < `${selfId}.json`)) n++;
  }
  return n;
}

async function waitForTurn(P, id, lane, ownerPid, background) {
  const maxWait = numEnv('AGENT_HARNESS_MAX_WAIT_S', 1200);
  const critAlone = numEnv('AGENT_HARNESS_CRITICAL_ALONE_S', 300);
  const poll = numEnv('AGENT_HARNESS_POLL_MS', 5000);
  const t0 = Date.now();
  const ticket = join(P.queue, `${id}.json`);
  if (lane) writeFileSync(ticket, JSON.stringify({ t0, pid: process.pid }));
  const log = (line) => {
    try {
      appendFileSync(P.log, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // logging is optional
    }
  };
  let waited = false;
  try {
    for (;;) {
      const { level, freePct } = pressure();
      const others = activeJobs(P, id);
      const secs = (Date.now() - t0) / 1000;
      const laneFree = !lane || (!others.some((j) => j.lane) && !laneAhead(P, id, t0));
      const go =
        (level === 'normal' && laneFree) ||
        (level === 'warning' && !others.length && laneFree) ||
        (level === 'critical' && !others.length && secs >= critAlone) ||
        secs >= maxWait;
      if (go) {
        if (waited || level !== 'normal') {
          log(`run ${id} after ${Math.round(secs)}s pressure=${level} free=${freePct ?? '?'}% others=${others.length}${lane ? ' lane' : ''}${secs >= maxWait ? ' TIMEOUT' : ''}`);
        }
        writeFileSync(
          join(P.jobs, `${id}.json`),
          JSON.stringify({ started: Date.now(), lane: lane || undefined, background, ownerPid: ownerPid || undefined }),
        );
        return;
      }
      if (!waited) log(`wait ${id} pressure=${level} free=${freePct ?? '?'}% others=${others.length}${lane ? ' lane' : ''}`);
      waited = true;
      await sleep(poll);
    }
  } finally {
    rmSync(ticket, { force: true }); // after the job entry exists, so the next in line sees it
  }
}

async function main() {
  const mode = process.argv[2];
  if (process.env.CI || process.env.AGENT_HARNESS_HEAVY_GATE === 'off') return;
  const root = findRoot();
  const cfg = loadConfig(root);
  const P = paths(root, cfg);
  ensureDir(P.jobs);
  ensureDir(P.queue);

  if (mode === 'lane-pre') {
    await waitForTurn(P, `lane-${String(process.argv[3] ?? process.ppid).replace(/[^\w-]/g, '')}`, true, Number(process.argv[4]) || null, false);
    return;
  }
  if (mode === 'lane-post') {
    rmSync(join(P.jobs, `lane-${String(process.argv[3] ?? '').replace(/[^\w-]/g, '')}.json`), { force: true });
    return;
  }
  const input = readStdinJson();
  const id = String(input.tool_use_id ?? '').replace(/[^\w-]/g, '');
  const command = String(input.tool_input?.command ?? '');
  const background = Boolean(input.tool_input?.run_in_background);
  if (!id) return;
  if (mode === 'pre') {
    const { heavy, lane } = classify(command, cfg);
    if (heavy) await waitForTurn(P, id, lane, null, background);
  } else if (mode === 'post') {
    // PostToolUse also fires when a foreground command is moved to the background; it still runs then.
    const moved = Boolean(input.tool_response?.backgroundTaskId);
    const entry = join(P.jobs, `${id}.json`);
    if (!background && !moved) rmSync(entry, { force: true });
  }
}

if (isMain(import.meta.url)) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
