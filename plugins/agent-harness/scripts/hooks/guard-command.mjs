#!/usr/bin/env node
// scripts/hooks/guard-command.mjs - a configurable shell-command guard for coding agents.
//
// Runs as a PreToolUse hook (matcher Bash) so a rule is enforced instead of only asked for.
//   node scripts/hooks/guard-command.mjs --format claude   Claude Code PreToolUse, Bash
//   node scripts/hooks/guard-command.mjs --format codex    Codex PreToolUse, shell
//   node scripts/hooks/guard-command.mjs --format cursor   Cursor beforeShellExecution
//   node scripts/hooks/guard-command.mjs --check "<cmd>"   print the decision, for testing
// The hook payload arrives on stdin as JSON.
//
// Decisions: deny (the reason tells the agent what to do instead), ask (a human confirms in the
// tool's own prompt), allow. The guard fails open: a payload it cannot read is allowed.
//
// Built-in rules (switch off with harness.guard.defaults = false):
//   - git push --force to the default branch, or a force push that names no branch (ask)
//   - deleting the default branch on the remote (git push origin :<branch>)
//   - rm -r of the repo root, the working directory, its parent, the home folder or /
//   - git reset --hard (and clean -f, checkout -f, restore, stash drop) while the tree has uncommitted changes
//   - publish and deploy commands: npm/pnpm/yarn publish, cargo publish, twine upload, gem push,
//     docker push, terraform apply, firebase deploy, gh release create, helm upgrade, kubectl apply/delete
//
// Config (agents.config.json, key "harness.guard"):
//   defaults  boolean, default true
//   deny      [{ "pattern": "<regex>", "reason": "<text>" } | "<regex>"]  extra deny rules
//   ask       same shape, decision "ask"
//   allow     ["<regex>"]  a command matching any of these is allowed, before every other rule
// "defaultBranch" (top level, default "main") is the branch the force-push rule protects.
// Rules are tested against the command with quoted text blanked, unless a shell is about to
// execute that text (sh -c, eval, xargs). Allow patterns are tested on the raw command.
//
// Env: AGENT_HARNESS_GUARD=off turns the guard off for one run.
// Exit codes: 0 always (the decision is in the JSON on stdout); 2 for a bad command line.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { findRoot, get, isMain, loadConfig, readStdinJson } from './lib/common.mjs';

const DEPLOY =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:npm\s+)?publish|cargo\s+publish|twine\s+upload|gem\s+push|docker\s+push|terraform\s+(?:apply|destroy)|firebase\s+deploy|gh\s+release\s+create|helm\s+(?:upgrade|install|uninstall)|kubectl\s+(?:apply|delete|rollout))(?:\s|$)/;

function norm(rules, decision, fallback) {
  const out = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    const pattern = typeof r === 'string' ? r : r?.pattern;
    if (typeof pattern !== 'string') continue;
    try {
      out.push({
        decision,
        re: new RegExp(pattern),
        reason: (typeof r === 'object' && r.reason) || fallback,
      });
    } catch {
      // bad pattern: skip it, never break the guard
    }
  }
  return out;
}

/** Real paths are compared, because /var and /private/var are the same place on macOS. */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function expand(arg, ctx) {
  let a = arg;
  if (a === '~' || a.startsWith('~/')) a = ctx.home + a.slice(1);
  a = a.replace(/^\$\{?HOME\}?/, ctx.home).replace(/^\$\{?PWD\}?/, ctx.cwd);
  return a;
}

/** The dangerous targets of an `rm -r...` segment, or [] when there are none. */
function dangerousRmTargets(segment, ctx) {
  const words = segment.trim().split(/\s+/);
  const at = words.findIndex((w) => /^(?:.*\/)?rm$/.test(w));
  if (at === -1) return [];
  const rest = words.slice(at + 1);
  const recursive = rest.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive');
  if (!recursive) return [];
  const protectedPaths = new Set(
    [ctx.root, ctx.cwd, dirname(ctx.root), ctx.home, '/'].map(real),
  );
  const bad = [];
  for (const w of rest) {
    if (w.startsWith('-')) continue;
    const star = /\/?\*+$/.test(w) || w === '*';
    const base = star ? w.replace(/\/?\*+$/, '') || (w.startsWith('/') ? '/' : '.') : w;
    const abs = real(isAbsolute(expand(base, ctx)) ? expand(base, ctx) : resolve(ctx.cwd, expand(base, ctx)));
    if (protectedPaths.has(abs)) bad.push(w);
  }
  return bad;
}

function pushParts(cmd) {
  // [{ force, deleteRef, names }] for every `git push` segment.
  const out = [];
  for (const seg of cmd.split(/&&|\|\||[;|\n(]/)) {
    const w = seg.trim().split(/\s+/);
    const at = w.findIndex((x, i) => x === 'git' && w.slice(i + 1).includes('push'));
    if (at === -1) continue;
    const rest = w.slice(w.indexOf('push', at) + 1);
    out.push({
      force: rest.some((x) => x === '--force' || x === '--force-with-lease' || x.startsWith('--force-with-lease=') || x === '--force-if-includes' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x) || /^\+/.test(x)),
      del: rest.includes('--delete') || rest.includes('-d'),
      refs: rest.filter((x) => !x.startsWith('-')),
    });
  }
  return out;
}

function defaultRules(ctx) {
  const b = ctx.defaultBranch;
  const names = (ref) => {
    const r = ref.replace(/^\+/, '');
    const dst = r.includes(':') ? r.slice(r.lastIndexOf(':') + 1) : r;
    return dst.replace(/^refs\/heads\//, '');
  };
  return [
    {
      decision: 'deny',
      test: (cmd) => pushParts(cmd).some((p) => p.force && p.refs.some((r) => names(r) === b)),
      reason: `Never force-push the default branch (${b}). Push a new branch or ask a human.`,
    },
    {
      decision: 'deny',
      test: (cmd) =>
        pushParts(cmd).some((p) => p.refs.some((r) => r.startsWith(':') && names(r.slice(1)) === b) || (p.del && p.refs.some((r) => names(r) === b))),
      reason: `Never delete the default branch (${b}) on the remote.`,
    },
    {
      decision: 'ask',
      test: (cmd) => pushParts(cmd).some((p) => p.force),
      reason: 'A force push rewrites remote history. Confirm the target branch first.',
    },
    {
      decision: 'deny',
      test: (cmd) => DEPLOY.test(cmd),
      reason: 'Publishing and deploying are run by a human. Stop and ask them to run it.',
    },
  ];
}

const DIRTY_RE =
  /\bgit\s+(?:reset\b[^|;&]*--(?:hard|merge|keep)\b|clean\b[^|;&]*\s-[a-zA-Z]*f|restore\b(?![^|;&]*--staged)|checkout\b[^|;&]*(?:\s--\s|\s\.(?:\s|$)|\s-f\b|\s--force\b)|stash\s+(?:drop|clear)\b)/;

export function dirtyTree(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return null; // not a repo, or git missing: unknown
  }
}

/**
 * decide(command, ctx) -> { decision, reason }.
 * ctx (all optional): cfg, root, cwd, home, defaultBranch, dirty (function: cwd -> true|false|null).
 */
export function decide(command, ctx = {}) {
  const root = ctx.root ?? findRoot();
  const cfg = ctx.cfg ?? loadConfig(root);
  const c = {
    root,
    cwd: ctx.cwd ?? process.cwd(),
    home: ctx.home ?? homedir(),
    defaultBranch: ctx.defaultBranch ?? get(cfg, 'defaultBranch', 'main'),
    dirty: ctx.dirty ?? dirtyTree,
  };
  if (process.env.AGENT_HARNESS_GUARD === 'off') return { decision: 'allow', reason: '' };

  for (const re of norm(get(cfg, 'harness.guard.allow', []), 'allow', '').map((r) => r.re)) {
    if (re.test(command)) return { decision: 'allow', reason: '' };
  }

  const flat = command.replace(/\s+/g, ' ');
  const executesQuoted = /\b(?:sh|bash|zsh)\s+-c\b|\beval\b|\bxargs\b/.test(flat);
  const cmd = executesQuoted ? flat : flat.replace(/'[^']*'|"[^"]*"/g, "''");

  const rules = [
    ...norm(get(cfg, 'harness.guard.deny', []), 'deny', 'Blocked by a project rule in agents.config.json.'),
    ...norm(get(cfg, 'harness.guard.ask', []), 'ask', 'A human confirms this command.'),
    ...(get(cfg, 'harness.guard.defaults', true) ? defaultRules(c) : []),
  ];
  for (const rule of rules) {
    if (rule.test ? rule.test(cmd) : rule.re.test(cmd)) return { decision: rule.decision, reason: rule.reason };
  }
  if (get(cfg, 'harness.guard.defaults', true)) {
    for (const seg of cmd.split(/&&|\|\||[;|\n(]/)) {
      const bad = dangerousRmTargets(seg, c);
      if (bad.length) {
        return {
          decision: 'deny',
          reason: `Never recursively delete the repo root, the working directory, its parent, the home folder or / (${bad.join(' ')}). Name the exact subfolder.`,
        };
      }
    }
    if (DIRTY_RE.test(cmd)) {
      const dirty = c.dirty(c.cwd);
      if (dirty === true) {
        return {
          decision: 'deny',
          reason: 'The working tree has uncommitted changes and this command would discard them. Commit or report them instead.',
        };
      }
      if (dirty === null) {
        return { decision: 'ask', reason: 'This command discards work and the tree state is unknown. Confirm first.' };
      }
    }
  }
  return { decision: 'allow', reason: '' };
}

const NAME = 'scripts/hooks/guard-command.mjs';
const FORMATS = {
  cursor: {
    command: (p) => p.command,
    reply: ({ decision, reason }) =>
      decision === 'allow'
        ? { permission: 'allow' }
        : { permission: decision, user_message: reason, agent_message: `Blocked by ${NAME}: ${reason}` },
  },
  claude: {
    command: (p) => p.tool_input?.command,
    reply: ({ decision, reason }) =>
      decision === 'allow'
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: decision,
              permissionDecisionReason: `Blocked by ${NAME}: ${reason}`,
            },
          },
  },
};
// Codex parses "ask" but does not act on it, so a confirm becomes a stop.
FORMATS.codex = {
  command: FORMATS.claude.command,
  reply: (r) =>
    FORMATS.claude.reply(
      r.decision === 'ask' ? { decision: 'deny', reason: `${r.reason} Ask the human to run it, then continue.` } : r,
    ),
};

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    const r = decide(args.slice(1).join(' '));
    process.stdout.write(`${r.decision}${r.reason ? ` - ${r.reason}` : ''}\n`);
    return;
  }
  const format = FORMATS[args[args.indexOf('--format') + 1]];
  if (!format) {
    process.stderr.write('usage: guard-command.mjs --format claude|codex|cursor  |  --check "<cmd>"\n');
    process.exit(2);
  }
  let command;
  try {
    command = format.command(readStdinJson());
  } catch {
    command = undefined;
  }
  const result = typeof command === 'string' && command.trim() ? decide(command) : { decision: 'allow', reason: '' };
  process.stdout.write(JSON.stringify(format.reply(result)));
}

if (isMain(import.meta.url)) main();
