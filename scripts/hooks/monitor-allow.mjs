#!/usr/bin/env node
// scripts/hooks/monitor-allow.mjs - auto-approve Monitor watches that only read.
//
// Runs as a PreToolUse hook, matcher Monitor. The command is parsed into simple commands; when
// every one is on a read-only allowlist (grep, tail, ls, sleep, git status/log/diff, gh pr checks,
// curl GET, ...) the hook answers "allow" so the watch starts without a prompt. Anything it cannot
// prove read-only gets no answer, so the normal permission prompt runs. It never denies, and a
// crash also means "ask". This is a convenience allowlist, not a sandbox: it keeps delete, move,
// push and deploy on the prompt; it does not stop a deliberately disguised command.
// Refused on purpose: redirects to files, heredocs, backticks, secret-like files and variables.
//
// Config (agents.config.json, key "harness.monitorAllow"):
//   commands   extra program names to treat as read-only (exact names, e.g. ["kubectl-get"])
// Env: AGENT_HARNESS_MONITOR_ALLOW=off disables the hook.
// Exit code: always 0.
import { findRoot, get, loadConfig } from './lib/common.mjs';

const SIMPLE = new Set([
  'true', 'false', ':', 'sleep', 'echo', 'printf', 'date', 'pwd', 'cd', 'read', 'break', 'continue', 'exit',
  'test', '[', '[[', ']]', 'grep', 'egrep', 'fgrep', 'tail', 'head', 'cat', 'wc', 'ls', 'stat', 'cut', 'tr',
  'basename', 'dirname', 'seq', 'du', 'df',
]);
const KEYWORDS = new Set(['while', 'until', 'if', 'then', 'else', 'elif', 'do', 'done', 'fi', '{', '}', '!']);
const BAD_ASSIGN = /^(PATH|IFS|BASH_ENV|ENV|SHELLOPTS|PROMPT_COMMAND|LD_\w*|DYLD_\w*|GIT_\w*|NODE_OPTIONS)=/;
const ASSIGN = /^[A-Za-z_]\w*=/;
const SECRET_PATH =
  /(^|[/=\s])\.env\b|\.(pem|p12|key|keystore|jks)$|id_(rsa|ed25519)|\.ssh\/|\.aws\/|\.npmrc|\.netrc|credentials/i;
const SECRET_VAR = /\$\{?\w*(TOKEN|SECRET|API_?KEY|PASSWORD|PASSWD|CRED|AUTH)/i;
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-remote', 'merge-base', 'describe',
  'branch',
]);
const CURL_SHORT = /^-[sSfLIikmwHg]+$/;
const CURL_LONG =
  /^--(silent|show-error|fail|fail-with-body|location|head|include|insecure|max-time|connect-timeout|retry|retry-delay|write-out|header|compressed)(=|$)/;
const SED_SCRIPT = /^(s([^\w\s])(?:\\.|(?!\2).)*\2(?:\\.|(?!\2).)*\2[gIip0-9]*|\d+(,\d+)?[pd])$/s;

// Splits shell text into simple commands (arrays of words), recursing into $( )
// and <( ). Returns { segments, end, unsafe }, with unsafe naming what it refused.
function scan(s, start = 0, nested = false) {
  const segments = [];
  let words = [];
  let word = '';
  let has = false;
  let i = start;
  const endWord = () => {
    if (has) words.push(word);
    word = '';
    has = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const sub = (from) => {
    const r = scan(s, from, true);
    segments.push(...r.segments);
    if (r.unsafe) return { unsafe: r.unsafe };
    return { next: r.end };
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] !== '\n') {
        word += s[i + 1] ?? '';
        has = true;
      }
      i += 2;
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return { segments, end: i, unsafe: 'open quote' };
      word += s.slice(i + 1, close);
      has = true;
      i = close + 1;
    } else if (c === '"') {
      has = true;
      i += 1;
      for (;;) {
        if (i >= s.length) return { segments, end: i, unsafe: 'open quote' };
        if (s[i] === '"') break;
        if (s[i] === '`') return { segments, end: i, unsafe: 'backtick' };
        if (s[i] === '\\') {
          word += s[i + 1] ?? '';
          i += 2;
        } else if (s.startsWith('$((', i)) {
          const close = s.indexOf('))', i);
          if (close < 0 || /[`$]\(|`/.test(s.slice(i + 3, close))) return { segments, end: i, unsafe: 'arithmetic' };
          word += '0';
          i = close + 2;
        } else if (s[i] === '$' && s[i + 1] === '(') {
          const r = sub(i + 2);
          if (r.unsafe) return { segments, end: i, unsafe: r.unsafe };
          word += '$()';
          i = r.next;
        } else {
          word += s[i];
          i += 1;
        }
      }
      i += 1;
    } else if (c === '`') {
      return { segments, end: i, unsafe: 'backtick' };
    } else if (c === '$' && s.startsWith('$((', i)) {
      const close = s.indexOf('))', i);
      if (close < 0 || /[`$]\(|`/.test(s.slice(i + 3, close))) return { segments, end: i, unsafe: 'arithmetic' };
      word += '0';
      has = true;
      i = close + 2;
    } else if (c === '$' && s[i + 1] === '(') {
      const r = sub(i + 2);
      if (r.unsafe) return { segments, end: i, unsafe: r.unsafe };
      word += '$()';
      has = true;
      i = r.next;
    } else if (c === '#' && !has) {
      while (i < s.length && s[i] !== '\n') i += 1;
    } else if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
    } else if (c === '\n' || c === ';' || c === '|') {
      endSegment();
      i += 1;
    } else if (c === '&') {
      const out = /^&>>?\s*\/dev\/null(?=[\s;|&)]|$)/.exec(s.slice(i));
      if (out) {
        i += out[0].length;
      } else if (s[i + 1] === '>') {
        return { segments, end: i, unsafe: 'redirect' };
      } else {
        endSegment();
        i += 1;
      }
    } else if (c === '(') {
      endSegment();
      i += 1;
    } else if (c === ')') {
      endSegment();
      if (nested) return { segments, end: i + 1 };
      i += 1;
    } else if (c === '<') {
      if (s[i + 1] === '<') return { segments, end: i, unsafe: 'heredoc' };
      endWord();
      if (s[i + 1] === '(') {
        const r = sub(i + 2);
        if (r.unsafe) return { segments, end: i, unsafe: r.unsafe };
        i = r.next;
      } else {
        i += 1;
      }
    } else if (c === '>') {
      if (/^\d+$/.test(word)) {
        word = '';
        has = false;
      }
      endWord();
      const out = /^(>&[12](?=[\s;|&)]|$)|>>?\s*\/dev\/null(?=[\s;|&)]|$))/.exec(s.slice(i));
      if (!out) return { segments, end: i, unsafe: 'redirect' };
      i += out[0].length;
    } else {
      word += c;
      has = true;
      i += 1;
    }
  }
  endSegment();
  return { segments, end: i, unsafe: nested ? 'open subshell' : undefined };
}

function curlOk(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (/^file:/i.test(a)) return false;
    if (!a.startsWith('-')) continue;
    if (/^-[sSfLIikmg]*o$/.test(a) && args[i + 1] === '/dev/null') {
      i += 1;
    } else if (/^-[sSfLIikmg]*u$/.test(a) || a === '--user') {
      i += 1;
    } else if (!CURL_SHORT.test(a) && !CURL_LONG.test(a)) {
      return false;
    }
  }
  return true;
}

function sedOk(args) {
  const scripts = [];
  let positional = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-e') {
      scripts.push(args[i + 1] ?? '');
      i += 1;
    } else if (a.startsWith('-')) {
      if (!/^-[nEru]+$/.test(a)) return false;
    } else if (!scripts.length && !positional) {
      scripts.push(a);
      positional = true;
    }
  }
  return scripts.length > 0 && scripts.every((x) => SED_SCRIPT.test(x));
}

function gitOk(args) {
  let i = 0;
  if (args[0] === '-C') i = 2;
  const verb = args[i];
  const rest = args.slice(i + 1);
  if (!GIT_READ.has(verb)) return false;
  if (rest.some((a) => /^--(output|ext-diff|textconv|upload-pack|exec)/.test(a))) return false;
  if (verb === 'branch') return rest.every((a) => /^(--show-current|--list|-a|-r|-v|-vv|--all|--remotes)$/.test(a));
  return true;
}

function ghOk(args) {
  const [area, verb] = args;
  if (area === 'pr') return ['checks', 'view', 'list', 'status'].includes(verb);
  if (area === 'run') return ['view', 'list', 'watch'].includes(verb);
  if (area === 'api') {
    return !args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a) && !/^(-X|--method)=?GET$/.test(a));
  }
  return false;
}

const EXTRA = new Set();

function commandOk(name, args) {
  if (SIMPLE.has(name) || EXTRA.has(name)) return true;
  switch (name) {
    case 'curl':
      return curlOk(args);
    case 'sed':
      return sedOk(args);
    case 'git':
      return gitOk(args);
    case 'gh':
      return ghOk(args);
    case 'adb': {
      const a = args[0] === '-s' ? args.slice(2) : args;
      if (a[0] === 'devices') return true;
      return a[0] === 'logcat' && !a.some((x) => /^(-c|--clear|-f|--file|-G|--buffer-size|-P|--prune)/.test(x));
    }
    case 'sort':
      return !args.some((a) => /^(-o|--output|--compress-program)/.test(a));
    case 'uniq':
      return args.every((a) => a.startsWith('-'));
    case 'rg':
      return !args.some((a) => /^--pre/.test(a));
    case 'jq':
      return !args.some((a) => /\benv\b|\$ENV/.test(a));
    case 'awk':
      return !args.some((a) => /system|getline|[|>]/.test(a));
    case 'find':
      return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a));
    case 'pgrep':
      return !args.some((a) => /^-[a-zA-Z]*[la]|^--list/.test(a));
    default:
      return false;
  }
}

export function decide(input) {
  if (input?.tool_name !== 'Monitor') return { allow: false, why: 'not Monitor' };
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return { allow: false, why: 'no command' };
  if (SECRET_VAR.test(command)) return { allow: false, why: 'secret variable' };

  const { segments, unsafe } = scan(command);
  if (unsafe) return { allow: false, why: unsafe };

  for (const raw of segments) {
    if (raw.some((w) => SECRET_PATH.test(w))) return { allow: false, why: 'secret file' };
    const words = [...raw];
    while (words.length && KEYWORDS.has(words[0])) words.shift();
    if (words[0] === 'for') continue;
    while (words.length && ASSIGN.test(words[0])) {
      if (BAD_ASSIGN.test(words[0])) return { allow: false, why: 'assignment' };
      words.shift();
    }
    if (!words.length) continue;
    const [name, ...args] = words;
    if (!commandOk(name, args)) return { allow: false, why: name };
  }
  return { allow: true, why: 'read-only' };
}

async function main() {
  if (process.env.AGENT_HARNESS_MONITOR_ALLOW === 'off') return;
  for (const name of get(loadConfig(findRoot()), 'harness.monitorAllow.commands', [])) {
    if (typeof name === 'string' && /^[\w.-]+$/.test(name)) EXTRA.add(name);
  }
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (!decide(JSON.parse(text)).allow) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Monitor command is read-only',
      },
    }),
  );
}

if (process.argv[1]?.endsWith('monitor-allow.mjs')) main().catch(() => {});
