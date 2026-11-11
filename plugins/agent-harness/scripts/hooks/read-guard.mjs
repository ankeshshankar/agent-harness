#!/usr/bin/env node
// scripts/hooks/read-guard.mjs - blocks a whole Read of a large text file.
//
// Runs as a PreToolUse hook, matcher Read. A ranged Read (offset > 0 or limit > 0) is always
// allowed. A whole read of a file over the size limit exits 2 with one stderr line telling the
// agent to grep for the part it needs and read a line range, or to ask a subagent for a summary.
// Binary-ish files (images, PDF, notebooks), SKILL.md and files that do not exist are allowed.
// Any error allows the read: a broken guard must not stop every read.
//
// Config (agents.config.json, key "harness.readGuard"):
//   maxBytes         default 40960
//   allowExtensions  extra extensions to always allow, e.g. [".lock"]
//   allowPaths       regex strings; a path matching any is allowed
// Env: AGENT_HARNESS_READ_MAX_BYTES overrides maxBytes. AGENT_HARNESS_READ_GUARD=off disables.
// Exit codes: 0 allow, 2 block.
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { compileAll, findRoot, get, isMain, loadConfig, numEnv, readStdinJson } from './lib/common.mjs';

const ALWAYS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ipynb', '.svg'];

export function decide(input, cfg = loadConfig(findRoot())) {
  if (process.env.AGENT_HARNESS_READ_GUARD === 'off') return { block: false };
  const ti = input?.tool_input ?? {};
  const p = ti.file_path;
  if (typeof p !== 'string' || !p) return { block: false };
  if (Number(ti.offset) > 0 || Number(ti.limit) > 0) return { block: false };
  const ext = extname(p).toLowerCase();
  const extra = get(cfg, 'harness.readGuard.allowExtensions', []).map((e) => String(e).toLowerCase());
  if (ALWAYS.includes(ext) || extra.includes(ext)) return { block: false };
  if (basename(p) === 'SKILL.md') return { block: false };
  if (compileAll(get(cfg, 'harness.readGuard.allowPaths', [])).some((re) => re.test(p))) return { block: false };
  const max = numEnv('AGENT_HARNESS_READ_MAX_BYTES', get(cfg, 'harness.readGuard.maxBytes', 40 * 1024));
  let size;
  try {
    size = statSync(p).size;
  } catch {
    return { block: false };
  }
  if (size <= max) return { block: false };
  return {
    block: true,
    message: `Whole read of ${p} (${Math.round(size / 4000)}k tokens) blocked: grep -n for the part you need and Read with offset/limit, or ask a subagent to summarise it.`,
  };
}

if (isMain(import.meta.url)) {
  try {
    const r = decide(readStdinJson());
    if (r.block) {
      process.stderr.write(`${r.message}\n`);
      process.exit(2);
    }
  } catch {
    // fail open
  }
}
