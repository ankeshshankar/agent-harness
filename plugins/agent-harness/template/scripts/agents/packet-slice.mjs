#!/usr/bin/env node
// scripts/agents/packet-slice.mjs - one packet's brief and spec, in one small file.
//
// A builder or reviewer that reads the whole spec and build brief carries tens of thousands of tokens
// into every later turn. The slice carries only what its packet needs, copied word for word:
//
//   frontmatter   spec, spec_status (from the spec, for the builder's approved-spec gate), packet, brief,
//                 generated_from (sha256 of the brief, the spec, and the record when a reference was
//                 resolved from it), tokens (characters / 4)
//   from the brief  the HARD RULES H2; the RISK POINTS rows the packet names (RV-n); the REPORT FORMAT H2;
//                   the packet's own body
//   from the spec   every section the packet's `- **Spec:**` line names, resolved as below. An H2 whose
//                   title starts with "AMENDMENTS" is appended once, after those sections; its tokens are
//                   a breakdown line of their own and do not count against the budget.
//
// Brief layout it expects (docs/templates has an example): frontmatter with `spec: <path>`; H2s named
// HARD RULES, RISK POINTS, REPORT FORMAT and PACKETS; under PACKETS one `### <ID>. <title>` per packet,
// each with a `- **Spec:** ...` line and optionally a `- **Name:** ...` line.
//
// Usage:
//   node scripts/agents/packet-slice.mjs --brief <brief.md> --packet <ID> [--out <path>] [--allow-over]
//   node scripts/agents/packet-slice.mjs --brief <brief.md> --all [--allow-over]
//   node scripts/agents/packet-slice.mjs --brief <brief.md> (--packet <ID> | --all) --check
//   node scripts/agents/packet-slice.mjs --check --all     every brief that has a slice directory
//
// The slice goes to <handoff>/<feature>/<packet>.md, <feature> being the brief's file name without
// `-build-brief.md`, <handoff> being paths.handoff in agents.config.json (default docs/handoff).
// --check regenerates in memory and fails if a slice is missing or stale; with --all it checks every
// slice file in the directory. Budget: harness.packetSlice.budgetTokens (default 12000) per slice, not
// counting the amendments section; over it, exit 1 ("packet too big, split it") unless --allow-over.
// The size breakdown is printed either way.
//
// How a `Spec:` reference resolves (split at `;` and `,` outside brackets, quotes and backticks):
//   SECTION NAME [(...)]        an upper-case run naming a spec H2 -> the whole H2 (with its H3s)
//   SECTION "Sub" / "Sub"       a quoted H3 title (prefix match) -> that H3; quoted text that is not an H3
//                               -> the smallest heading whose text contains it
//   SECTION row X               the table row in that H2 with a cell exactly X (plus the table header)
//   D3, SD-6, T-J1-T-J4, K2-K4  an id -> its defining table row, `- **ID**` item or `**ID ...` paragraph,
//                               under its H2/H3 heading line. <Spec>.md is searched first, then
//                               <Spec>.record.md when that file exists
//   [C] ..., `x.mdc` ...        another document: listed as external, not sliced
// Anything else is an unresolvable reference: a hard error that lists every one.
//
// Exit codes: 0 ok, 1 a slice failed or is stale or too big, 2 bad arguments. No dependencies.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { findRoot, get, loadConfig } from '../hooks/lib/common.mjs';

const ROOT = findRoot();
const CFG = loadConfig(ROOT);
const HANDOFF = join(ROOT, get(CFG, 'paths.handoff', 'docs/handoff'));
const BUDGET = Number(get(CFG, 'harness.packetSlice.budgetTokens', 12000));
const SELF = 'scripts/agents/packet-slice.mjs';

// Id prefixes used by specs and briefs: decisions, spec decisions, requirements, amendments,
// risks, human steps, tests, open questions, contract gaps, blockers, device rows, spikes.
const ID = String.raw`(?:SD-|OQ-|CG-|DC-|RV-|T-[A-Z]|B-|R-|A-|S-|D|R|H|K)\d+`;
const ID_RE = new RegExp(String.raw`(?<![\w-])(${ID})(?![\w-])`, 'g');
const RANGE_RE = new RegExp(String.raw`(?<![\w-])(${ID})\s*–\s*(${ID})(?![\w-])`, 'g');

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { all: false, check: false, allowOver: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--allow-over') opts.allowOver = true;
    else if (a === '--brief' || a === '--packet' || a === '--out') {
      const v = argv[++i];
      if (!v) usage(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else usage(`unknown argument ${a}`);
  }
  if (!opts.packet && !opts.all) usage('give --packet <ID> or --all');
  if (opts.packet && opts.all) usage('--packet and --all are exclusive');
  if (!opts.brief && !(opts.check && opts.all)) usage('--brief is required (except --check --all)');
  if (opts.out && !opts.packet) usage('--out needs --packet');
  return opts;
}

function usage(msg) {
  console.error(`packet-slice: ${msg}`);
  console.error(
    'usage: node scripts/agents/packet-slice.mjs --brief <brief.md> (--packet <ID> | --all) [--out <path>] [--check] [--allow-over]',
  );
  process.exit(2);
}

// ---------------------------------------------------------------- markdown model

/** Lines, frontmatter and the heading tree of a markdown file, ignoring `#` inside code fences. */
function load(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
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
  const headings = [];
  const inFence = new Array(lines.length).fill(false);
  let fence = false;
  for (let i = body; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
      inFence[i] = true;
      continue;
    }
    inFence[i] = fence;
    const m = !fence && /^(#{1,6}) (.*)$/.exec(lines[i]);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), start: i, end: lines.length });
  }
  for (let i = 0; i < headings.length; i++) {
    const next = headings.slice(i + 1).find((h) => h.level <= headings[i].level);
    if (next) headings[i].end = next.start;
  }
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { path, text, lines, front, body, headings, inFence, sha256 };
}

/** The deepest heading (H2 or lower) whose range holds line i. */
function enclosing(doc, i) {
  let best = null;
  for (const h of doc.headings) {
    if (h.level >= 2 && h.start <= i && i < h.end && (!best || h.level > best.level)) best = h;
  }
  return best;
}

function parentH2(doc, h) {
  if (h.level === 2) return h;
  return doc.headings.find((p) => p.level === 2 && p.start < h.start && h.start < p.end) ?? null;
}

/** Trim trailing blank lines and horizontal rules from a [start, end) range. */
function trimEnd(doc, start, end) {
  while (end > start + 1 && /^(\s*|---)$/.test(doc.lines[end - 1])) end--;
  return end;
}

const tableStartOf = (doc, i) => {
  while (i > 0 && doc.lines[i - 1].startsWith('|')) i--;
  return i;
};

// ---------------------------------------------------------------- id definitions

/** The defining unit of an id: a table row, a `- **ID**` item or a `**ID …` paragraph. */
function findDefinition(doc, id, within = null) {
  const esc = id.replace(/[-]/g, '\\-');
  const row = new RegExp(String.raw`^\|\s*${esc}\s*\|`);
  const item = new RegExp(String.raw`^- \*\*${esc}(\*\*|[\s—:.])`);
  const para = new RegExp(String.raw`^\*\*${esc}[\s—:.*]`);
  const lo = within ? within.start : doc.body;
  const hi = within ? within.end : doc.lines.length;
  for (let i = lo; i < hi; i++) {
    if (doc.inFence[i]) continue;
    const l = doc.lines[i];
    if (row.test(l)) {
      const t = tableStartOf(doc, i);
      return { kind: 'row', start: i, end: i + 1, table: t, label: id };
    }
    if (item.test(l)) {
      let j = i + 1;
      while (j < hi && doc.lines[j] !== '' && /^\s/.test(doc.lines[j])) j++;
      return { kind: 'item', start: i, end: j, label: id };
    }
    if (para.test(l)) {
      let j = i + 1;
      while (j < hi) {
        const cur = doc.lines[j];
        if (/^#{1,6} /.test(cur) && !doc.inFence[j]) break;
        if (doc.lines[j - 1] === '' && /^(\*\*|\||- \*\*)/.test(cur) && !para.test(cur)) break;
        j++;
      }
      return { kind: 'para', start: i, end: trimEnd(doc, i, j), label: id };
    }
  }
  return null;
}

/** Ids in a string, ranges (`T-J1–T-J4`, `K2–K4`) expanded. */
function idsIn(s) {
  const out = [];
  const rest = s.replace(RANGE_RE, (whole, a, b) => {
    const pa = /^(.*?)(\d+)$/.exec(a);
    const pb = /^(.*?)(\d+)$/.exec(b);
    if (pa[1] !== pb[1] || Number(pb[2]) < Number(pa[2])) {
      out.push(a, b);
    } else {
      for (let n = Number(pa[2]); n <= Number(pb[2]); n++) out.push(`${pa[1]}${n}`);
    }
    return ' ';
  });
  for (const m of rest.matchAll(ID_RE)) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------- the Spec: line

/** Split at `;` and `,` outside (), [], "" and backticks. */
function splitRefs(s) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let tick = false;
  let cur = '';
  for (const ch of s) {
    if (ch === '`' && !quote) tick = !tick;
    else if (ch === '"' && !tick) quote = !quote;
    else if (!tick && !quote && (ch === '(' || ch === '[')) depth++;
    else if (!tick && !quote && (ch === ')' || ch === ']')) depth = Math.max(0, depth - 1);
    if (!tick && !quote && depth === 0 && (ch === ';' || ch === ',')) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim().replace(/\.$/, '').trim()).filter(Boolean);
}

/** Text outside brackets and backticks. */
function bareOf(s) {
  let out = s.replace(/`[^`]*`/g, ' ');
  let prev;
  do {
    prev = out;
    out = out.replace(/\([^()]*\)/g, ' ');
  } while (out !== prev);
  return out;
}

const normTitle = (t) =>
  t
    .replace(/\s*\(.*$/, '')
    .replace(/^\d+(\.\d+)*\.?\s+/, '')
    .trim();

function resolveSpecRefs(spec, refText, record = null) {
  const h2sOf = (doc) => doc.headings.filter((h) => h.level === 2);
  const h3sOf = (doc) => doc.headings.filter((h) => h.level === 3);
  const matchH2 = (doc, name) =>
    h2sOf(doc).filter((h) => {
      const t = normTitle(h.title);
      return t === name || t === `${name}S` || t.startsWith(`${name} `);
    });
  const picks = [];
  const external = [];
  const unresolved = [];
  let prevExternal = false;

  const addId = (id, why) => {
    let def = findDefinition(spec, id);
    let doc = spec;
    if (!def && record) {
      def = findDefinition(record, id);
      doc = record;
    }
    if (def) picks.push({ ...def, doc });
    else
      unresolved.push(`${id} (in "${why}": no table row, - **${id}** item or **${id} paragraph)`);
  };
  const addSection = (doc, h) =>
    picks.push({ kind: 'section', start: h.start, end: h.end, label: h.title, doc });
  const findInText = (doc, q, scope) => {
    const lo = scope ? scope.start : doc.body;
    const hi = scope ? scope.end : doc.lines.length;
    for (let i = lo; i < hi; i++) if (doc.lines[i].includes(q)) return enclosing(doc, i);
    return null;
  };

  for (const seg of splitRefs(refText)) {
    const bare = bareOf(seg);
    if (
      /\[[A-Za-z][\w ]*\]/.test(seg) ||
      /`[^`]*\.mdc`/.test(seg) ||
      (prevExternal && /^\s*§/.test(bare))
    ) {
      external.push(seg);
      prevExternal = true;
      continue;
    }
    prevExternal = false;
    const run = /^([A-Z]{2,}(?: [A-Z]{2,})*)(?![\w-])/.exec(bare.trim());
    let h2 = null;
    let h2Doc = spec;
    let rest = bare;
    if (run) {
      const name = run[1];
      let hits = matchH2(spec, name);
      if (hits.length === 0 && record) {
        hits = matchH2(record, name);
        h2Doc = record;
      }
      if (hits.length !== 1) {
        unresolved.push(`${name} (in "${seg}": ${hits.length ? 'ambiguous' : 'no such spec H2'})`);
        continue;
      }
      h2 = hits[0];
      rest = bare.trim().slice(name.length);
    }
    const quoted = [...rest.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const row = /\brow ([A-Za-z][\w-]*)/.exec(rest);
    const bareIds = idsIn(rest.replace(/"[^"]*"/g, ' ').replace(/\brow [A-Za-z][\w-]*/, ' '));
    const parenIds = idsIn(seg.replace(/`[^`]*`/g, ' ')).filter((id) => !bareIds.includes(id));

    for (const q of quoted) {
      const pool = h2
        ? h3sOf(h2Doc).filter((h) => h.start > h2.start && h.start < h2.end)
        : h3sOf(spec);
      let hits = pool.filter((h) => h.title.startsWith(q));
      let qDoc = h2 ? h2Doc : spec;
      if (hits.length !== 1 && !h2 && record) {
        const recHits = h3sOf(record).filter((h) => h.title.startsWith(q));
        if (recHits.length) {
          hits = recHits;
          qDoc = record;
        }
      }
      if (hits.length === 1) addSection(qDoc, hits[0]);
      else if (hits.length > 1) unresolved.push(`"${q}" (in "${seg}": ambiguous heading)`);
      else {
        let h = findInText(h2 ? h2Doc : spec, q, h2);
        let tDoc = h2 ? h2Doc : spec;
        if (!h && !h2 && record) {
          h = findInText(record, q, null);
          tDoc = record;
        }
        if (h) addSection(tDoc, h);
        else
          unresolved.push(
            `"${q}" (in "${seg}": no heading and no text match${h2 ? ` in ${h2.title}` : ''})`,
          );
      }
    }
    if (row) {
      if (!h2) unresolved.push(`row ${row[1]} (in "${seg}": no section named)`);
      else {
        let found = null;
        for (let i = h2.start; i < h2.end && !found; i++) {
          const l = h2Doc.lines[i];
          if (l.startsWith('|') && l.split('|').some((c) => c.trim() === row[1])) {
            found = {
              kind: 'row',
              start: i,
              end: i + 1,
              table: tableStartOf(h2Doc, i),
              label: `row ${row[1]}`,
              doc: h2Doc,
            };
          }
        }
        if (found) picks.push(found);
        else unresolved.push(`row ${row[1]} (in "${seg}": no table row in ${h2.title})`);
      }
    }
    for (const id of bareIds) addId(id, seg);
    for (const id of parenIds) addId(id, seg);
    if (h2 && !quoted.length && !row && !bareIds.length) addSection(h2Doc, h2);
    if (!h2 && !quoted.length && !bareIds.length && !parenIds.length) {
      // A bare qualifier left over from a split ("5", "(6)", "steps 4") is not a reference.
      if (!/^[\s\d§.–()a-z-]*$/.test(bare))
        unresolved.push(`"${seg}" (not a spec heading, quoted title or id)`);
    }
  }
  return { picks, external, unresolved };
}

// ---------------------------------------------------------------- rendering

/** Render picks verbatim, in document order, each under its heading line(s). */
function render(doc, picks) {
  const sections = picks.filter((p) => p.kind === 'section');
  const covered = (p) => sections.some((s) => s !== p && s.start <= p.start && p.end <= s.end);
  const seen = new Set();
  const keep = picks
    .filter((p) => !covered(p))
    .filter((p) => {
      const k = `${p.start}:${p.end}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.start - b.start);

  const blocks = [];
  const shownHeadings = new Set();
  let cur = null;
  for (const p of keep) {
    const h =
      p.kind === 'section'
        ? doc.headings.find((x) => x.start === p.start)
        : enclosing(doc, p.start);
    const h2 = h ? parentH2(doc, h) : null;
    const ctx = [];
    if (h2 && h2 !== h && !shownHeadings.has(h2.start)) ctx.push(h2);
    if (p.kind !== 'section' && h && !shownHeadings.has(h.start)) ctx.push(h);
    for (const c of ctx) shownHeadings.add(c.start);
    if (p.kind === 'section') shownHeadings.add(p.start);
    const label = h2 ? normTitle(h2.title) : 'spec';
    if (!cur || cur.label !== label || ctx.length) {
      cur = { label, ids: [], out: [] };
      blocks.push(cur);
    }
    for (const c of ctx) cur.out.push(doc.lines[c.start], '');
    if (p.kind === 'section') {
      cur.out.push(...doc.lines.slice(p.start, trimEnd(doc, p.start, p.end)), '');
      cur.ids.push(h.level === 2 ? '(whole)' : `"${normTitle(h.title)}"`);
    } else if (p.kind === 'row') {
      const last = cur.out.length >= 2 ? cur.lastRow : null;
      if (last && last.table === p.table) cur.out.splice(cur.out.length - 1, 0, doc.lines[p.start]);
      else cur.out.push(doc.lines[p.table], doc.lines[p.table + 1], doc.lines[p.start], '');
      cur.ids.push(p.label);
    } else {
      cur.out.push(...doc.lines.slice(p.start, p.end), '');
      cur.ids.push(p.label);
    }
    cur.lastRow = p.kind === 'row' ? p : null;
  }
  return blocks;
}

const tok = (s) => Math.ceil(s.length / 4);
const rel = (p) => {
  const r = relative(ROOT, p).split('\\').join('/');
  return r.startsWith('..') ? p : r;
};

function featureOf(briefPath) {
  const b = basename(briefPath);
  if (!b.endsWith('-build-brief.md'))
    throw new Error(`brief must be named <feature>-build-brief.md: ${b}`);
  return b.slice(0, -'-build-brief.md'.length);
}

function packetsOf(brief) {
  const packetsH2 = brief.headings.find((h) => h.level === 2 && /PACKETS/.test(h.title));
  if (!packetsH2) throw new Error(`${rel(brief.path)}: no "PACKETS" H2`);
  return brief.headings
    .filter((h) => h.level === 3 && h.start > packetsH2.start && h.start < packetsH2.end)
    .map((h) => ({ h, id: /^([A-Za-z0-9][\w-]*)\.\s/.exec(h.title)?.[1] }))
    .filter((p) => p.id);
}

/** Build one slice in memory. Throws with every problem listed. */
function buildSlice(brief, packetId) {
  const problems = [];
  const specPath = (brief.front.spec ?? '').split(/\s+/)[0];
  if (!specPath) throw new Error(`${rel(brief.path)}: frontmatter has no "spec:"`);
  const specAbs = join(ROOT, specPath);
  if (!existsSync(specAbs))
    throw new Error(`spec ${specPath} (from the brief's frontmatter) does not exist`);
  const spec = load(specAbs);
  const amendments = spec.headings.find(
    (h) => h.level === 2 && h.title.startsWith('AMENDMENTS'),
  );
  const recordAbs = join(ROOT, specPath.replace(/\.md$/, '.record.md'));
  const record = existsSync(recordAbs) ? load(recordAbs) : null;

  const packet = packetsOf(brief).find((p) => p.id === packetId);
  if (!packet) throw new Error(`${rel(brief.path)}: no packet "### ${packetId}." under PACKETS`);
  const pStart = packet.h.start;
  const pEnd = trimEnd(brief, pStart, packet.h.end);
  const packetText = brief.lines.slice(pStart, pEnd).join('\n');

  const h2 = (re, what) => {
    const h = brief.headings.find((x) => x.level === 2 && re.test(x.title));
    if (!h) problems.push(`brief has no ${what} H2`);
    return h;
  };
  const rules = h2(/HARD RULES/, 'HARD RULES');
  const risks = h2(/RISK POINTS/, 'RISK POINTS');
  const report = h2(/REPORT FORMAT/, 'REPORT FORMAT');

  // The Spec: line and its continuation lines.
  const specLineIdx = brief.lines
    .slice(pStart, pEnd)
    .findIndex((l) => /^(- )?\*\*Spec:\*\*/.test(l));
  let refText = '';
  if (specLineIdx < 0) problems.push(`packet ${packetId} has no "- **Spec:**" line`);
  else {
    let i = pStart + specLineIdx;
    const parts = [brief.lines[i].replace(/^(- )?\*\*Spec:\*\*\s*/, '')];
    while (++i < pEnd && /^\s+\S/.test(brief.lines[i])) parts.push(brief.lines[i].trim());
    refText = parts.join(' ');
  }
  const { picks, external, unresolved } = refText
    ? resolveSpecRefs(spec, refText, record)
    : { picks: [], external: [], unresolved: [] };
  const recordUsed = Boolean(record && picks.some((p) => p.doc === record));
  for (const u of unresolved) problems.push(`unresolvable Spec: reference ${u}`);

  // Risk points the packet names.
  const rvIds = [...new Set([...packetText.matchAll(/(?<![\w-])RV-\d+(?!\d)/g)].map((m) => m[0]))];
  const rvPicks = [];
  if (risks) {
    for (const id of rvIds) {
      const d = findDefinition(brief, id, risks);
      if (d) rvPicks.push(d);
      else problems.push(`risk point ${id} named by ${packetId} is not a row of ${risks.title}`);
    }
  }
  if (problems.length) {
    const err = new Error(problems.map((p) => `  - ${p}`).join('\n'));
    err.problems = problems;
    throw err;
  }

  const section = (h) => brief.lines.slice(h.start, trimEnd(brief, h.start, h.end)).join('\n');
  const parts = [];
  parts.push({ label: 'brief HARD RULES', text: section(rules) });
  if (rvPicks.length) {
    const rb = render(brief, rvPicks);
    parts.push({
      label: `brief risk points (${rvIds.join(', ')})`,
      text: rb.map((b) => b.out.join('\n').trimEnd()).join('\n\n'),
    });
  }
  parts.push({ label: 'brief REPORT FORMAT', text: section(report) });
  parts.push({ label: `packet ${packetId} body`, text: packetText });
  for (const b of render(
    spec,
    picks.filter(
      (p) =>
        p.doc === spec && !(amendments && p.start >= amendments.start && p.start < amendments.end),
    ),
  )) {
    parts.push({ label: `spec ${b.label}: ${b.ids.join(', ')}`, text: b.out.join('\n').trimEnd() });
  }
  if (recordUsed) {
    for (const b of render(
      record,
      picks.filter((p) => p.doc === record),
    )) {
      parts.push({
        label: `spec record ${b.label}: ${b.ids.join(', ')}`,
        text: b.out.join('\n').trimEnd(),
      });
    }
  }
  if (amendments) {
    parts.push({
      label: 'spec AMENDMENTS',
      text: spec.lines
        .slice(amendments.start, trimEnd(spec, amendments.start, amendments.end))
        .join('\n'),
      excludeFromBudget: true,
    });
  }

  const head = (tokens) =>
    [
      '---',
      `spec: ${specPath}`,
      `spec_status: ${spec.front.status ?? 'missing'}`,
      `packet: ${packetId}`,
      `brief: ${rel(brief.path)}`,
      'generated_from:',
      `  brief_sha256: ${brief.sha256}`,
      `  spec_sha256: ${spec.sha256}`,
      ...(recordUsed ? [`  record_sha256: ${record.sha256}`] : []),
      `tokens: ${tokens}`,
      '---',
      '',
      `<!-- GENERATED by ${SELF} — never edit. Regenerate: node ${SELF} --brief ${rel(brief.path)} --packet ${packetId} -->`,
      ...(external.length
        ? ['', `<!-- External references in the Spec: line, not sliced: ${external.join('; ')} -->`]
        : []),
      '',
    ].join('\n');
  const body = ['<!-- prettier-ignore-start -->', '', `# Brief: ${rel(brief.path)}`, ''];
  const briefParts = parts.filter((p) => !p.label.startsWith('spec '));
  const specParts = parts.filter((p) => p.label.startsWith('spec '));
  body.push(...briefParts.flatMap((p) => [p.text, '']));
  body.push(`# Spec: ${specPath}`, '');
  body.push(...specParts.flatMap((p) => [p.text, '']));
  body.push('<!-- prettier-ignore-end -->', '');
  const bodyText = body.join('\n');

  let tokens = 0;
  let content = '';
  for (let k = 0; k < 4; k++) {
    content = `${head(tokens)}\n${bodyText}`;
    const next = tok(content);
    if (next === tokens) break;
    tokens = next;
  }
  const overhead = tokens - parts.reduce((n, p) => n + tok(p.text), 0);
  const amendmentTokens = parts
    .filter((p) => p.excludeFromBudget)
    .reduce((n, p) => n + tok(p.text), 0);
  return {
    content,
    tokens,
    amendmentTokens,
    breakdown: [
      ...parts.map((p) => ({ label: p.label, tokens: tok(p.text) })),
      { label: 'frontmatter and wrappers', tokens: overhead },
    ],
    external,
    out: join(dirname(brief.path), featureOf(brief.path), `${packetId}.md`),
  };
}

function printBreakdown(id, s, over) {
  const note = s.amendmentTokens ? `; ${s.amendmentTokens} amendments excluded` : '';
  console.log(`${id}: ${s.tokens} tokens (budget ${BUDGET}${note})${over ? ' — OVER BUDGET' : ''}`);
  for (const b of s.breakdown) console.log(`  ${String(b.tokens).padStart(6)}  ${b.label}`);
  if (s.external.length) console.log(`  external, not sliced: ${s.external.join('; ')}`);
}

// ---------------------------------------------------------------- main

function run(opts, briefPath) {
  const brief = load(briefPath);
  const dir = join(dirname(briefPath), featureOf(briefPath));
  let failed = 0;

  let ids;
  if (opts.packet) ids = [opts.packet];
  else if (opts.check) {
    ids = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.slice(0, -3))
      : [];
    const known = new Set(packetsOf(brief).map((p) => p.id));
    for (const id of ids.filter((x) => !known.has(x))) {
      console.error(
        `STALE ${rel(join(dir, `${id}.md`))}: no packet ${id} in ${rel(briefPath)} (orphaned slice)`,
      );
      failed++;
    }
    ids = ids.filter((x) => known.has(x));
  } else ids = packetsOf(brief).map((p) => p.id);

  for (const id of ids) {
    let s;
    try {
      s = buildSlice(brief, id);
    } catch (e) {
      console.error(`${id}: cannot slice\n${e.message}`);
      failed++;
      continue;
    }
    const out = opts.out ? resolve(opts.out) : s.out;
    const counted = s.tokens - s.amendmentTokens;
    const over = counted > BUDGET;
    if (opts.check) {
      if (!existsSync(out)) {
        console.error(
          `MISSING ${rel(out)} — run: node ${SELF} --brief ${rel(briefPath)} --packet ${id}`,
        );
        failed++;
        continue;
      }
      const disk = readFileSync(out, 'utf8');
      if (disk !== s.content) {
        const why = [];
        const bh = /brief_sha256: (\w+)/.exec(disk)?.[1];
        const sh = /spec_sha256: (\w+)/.exec(disk)?.[1];
        const rh = /record_sha256: (\w+)/.exec(disk)?.[1];
        const newRh = /record_sha256: (\w+)/.exec(s.content)?.[1];
        if (bh !== brief.sha256) why.push('brief changed');
        if (sh && !s.content.includes(sh)) why.push('spec changed');
        if (rh !== newRh) why.push('record changed');
        if (!why.length)
          why.push(
            'differs from a fresh generation: edited by hand, or another brief path or script version',
          );
        console.error(
          `STALE ${rel(out)} (${why.join(', ')}) — run: node ${SELF} --brief ${rel(briefPath)} --packet ${id}`,
        );
        failed++;
        continue;
      }
      console.log(`ok ${rel(out)} (${s.tokens} tokens)`);
      continue;
    }
    printBreakdown(id, s, over);
    if (over && !opts.allowOver) {
      console.error(
        `${id}: packet too big, split it (${counted} > ${BUDGET} tokens; nothing written)`,
      );
      failed++;
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, s.content);
    console.log(`  wrote ${rel(out)}`);
  }
  return failed;
}

const opts = parseArgs(process.argv.slice(2));
let briefs;
if (opts.brief) briefs = [resolve(opts.brief)];
else {
  briefs = (existsSync(HANDOFF) ? readdirSync(HANDOFF) : [])
    .filter((f) => f.endsWith('-build-brief.md'))
    .map((f) => join(HANDOFF, f))
    .filter((f) => {
      const d = join(HANDOFF, featureOf(f));
      return existsSync(d) && statSync(d).isDirectory();
    });
}
let failed = 0;
for (const b of briefs) {
  try {
    failed += run(opts, b);
  } catch (e) {
    console.error(`packet-slice: ${e.message}`);
    failed++;
  }
}
if (opts.check && !failed)
  console.log(`packet-slice --check: ${briefs.length} brief(s) with slices, all current.`);
process.exit(failed ? 1 : 0);
