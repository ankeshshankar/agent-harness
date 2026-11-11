#!/usr/bin/env node
// scripts/hooks/context-guard.mjs - one reminder when a session's context gets large.
//
// Runs as a UserPromptSubmit hook. It reads the newest assistant usage line from the session
// transcript (transcript_path in the payload), adds input + cache tokens, and when the total
// crosses the threshold it adds one line of context for the model: save progress to the state
// file and the build log, then carry on. It repeats only after the context grows another
// `step` tokens, and starts over after a compaction (context shrinks).
//
// Config (agents.config.json, key "harness.contextGuard"):
//   tokens   first threshold, default 150000
//   step     growth between reminders, default 100000
//   message  text of the reminder; "{k}" becomes the size in thousands of tokens
// Env: AGENT_HARNESS_CONTEXT_TOKENS overrides tokens; AGENT_HARNESS_CONTEXT_GUARD=off disables.
// State: <stateDir>/context-guard-<session>.json (git-ignored).
// Exit code: always 0. Any error prints nothing (fail open).
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { ensureDir, findRoot, get, isMain, loadConfig, numEnv, readStdinJson, stateDir } from './lib/common.mjs';

const TAIL_BYTES = 200 * 1024;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function latestUsage(transcriptPath) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const length = Math.min(size, TAIL_BYTES);
    const start = size - length;
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, n).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl === -1) return null;
      text = text.slice(nl + 1);
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = obj?.type === 'assistant' ? obj.message?.usage : null;
      if (usage && typeof usage === 'object') return usage;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Pure decision: should this prompt get a reminder? Returns { remind, lastAt } (lastAt null = clear the state). */
export function evaluate(context, lastAt, limit, step) {
  if (context < limit) return { remind: false, lastAt: null };
  let last = lastAt;
  if (last !== null && context < last) last = null;
  if (last !== null && context < last + step) return { remind: false, lastAt: last };
  return { remind: true, lastAt: context };
}

const DEFAULT_MESSAGE =
  'Context is ~{k}K tokens. Before it is compacted, bring the state file and the build log up to date (node scripts/agents/log-round.mjs) so nothing is lost. Then carry on with the request as normal: do not stop work or ask the user to start a new chat.';

function run() {
  if (process.env.AGENT_HARNESS_CONTEXT_GUARD === 'off') return;
  const input = readStdinJson();
  const session = input?.session_id;
  const transcript = input?.transcript_path;
  if (typeof session !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(session)) return;
  if (typeof transcript !== 'string' || !transcript) return;
  const root = findRoot();
  const cfg = loadConfig(root);
  const dir = stateDir(root, cfg);
  const file = `${dir}/context-guard-${session}.json`;

  const usage = latestUsage(transcript);
  if (!usage) return;
  const context = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
  const limit = numEnv('AGENT_HARNESS_CONTEXT_TOKENS', get(cfg, 'harness.contextGuard.tokens', 150_000));
  const step = get(cfg, 'harness.contextGuard.step', 100_000);

  let lastAt = null;
  try {
    const at = Number(JSON.parse(readFileSync(file, 'utf8'))?.lastAt);
    lastAt = Number.isFinite(at) ? at : null;
  } catch {
    // no state yet
  }
  const r = evaluate(context, lastAt, limit, step);
  if (r.lastAt === null) {
    try {
      rmSync(file, { force: true });
    } catch {
      // a stale file only delays a reminder
    }
  }
  if (!r.remind) return;
  const message = String(get(cfg, 'harness.contextGuard.message', DEFAULT_MESSAGE)).replace('{k}', String(Math.round(context / 1000)));
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } }),
  );
  try {
    ensureDir(dir);
    writeFileSync(file, `${JSON.stringify({ lastAt: r.lastAt })}\n`);
  } catch {
    // the reminder is out; a missed write only repeats it
  }
}

if (isMain(import.meta.url)) {
  try {
    run();
  } catch {
    // fail open
  }
}
