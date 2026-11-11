#!/usr/bin/env bash
# scripts/agents/run-packet.sh - run ONE packet in a fresh headless agent session.
#
#   scripts/agents/run-packet.sh <brief-path> <packet-id> [--model <m>] [--effort <e>] [--worktree]
#       [--base <ref>] [--merge <ref>]... [--defer-verify] [--dry-run]
#
# One packet per fresh session keeps the context small. The script refreshes the packet's slice
# (scripts/agents/packet-slice.mjs), refuses a packet whose spec_status is not "approved", then runs the
# headless agent from the project root. The brief must be named <feature>-build-brief.md; the slice is
# <dir of brief>/<feature>/<packet>.md. The prompt asks the session to run the orchestrate skill for this
# one packet: builder, round checks, a fresh reviewer every round, at most 3 rounds, the full verify
# command once on PROCEED, a build-log entry per round (log-round.mjs), and one final RESULT line.
#
# --worktree  run in a new git worktree <worktreeDir>/<packet>-wt on branch packet/<packet>-<time>
#             (from HEAD), with the agent setup copied in and the install command run. Before a new
#             worktree is made, clean-worktrees.sh removes older packet worktrees that are merged,
#             clean and not in use (branches are kept).
# --base <ref>   start the worktree branch from <ref> instead of HEAD.
# --merge <ref>  (repeatable) `git merge --no-edit` <ref> into the new worktree before the session starts.
#             --base and --merge need --worktree, must match ^packet/ and exist as a local branch, else
#             exit 2. A merge conflict aborts the merge, removes the new worktree and branch, exit 2.
#             `BRANCH <branch>` is printed to stdout as soon as the worktree branch exists.
# --defer-verify  the packet does not run the full verify command; it runs only the tests for its own
#             files, and the full check runs once per finished flow (scripts/bin/check-lane.sh).
#             Same as AGENT_HARNESS_DEFER_VERIFY=1.
# --dry-run   print the command and the prompt; start nothing.
#
# Never passes a flag that skips permission checks. Project hooks (guards) still apply.
#
# Config (agents.config.json): commands.verify, commands.test, packageManager, rolePrefix, paths.handoff,
# and under "harness": stateDir (default .agent-harness), headless.{command,model,effort,args},
# worktree.{dir,copy,install}, roles.{builder,reviewer}. See scripts/hooks/README.md.
# Env: AGENT_HARNESS_ROOT (project), AGENT_HARNESS_HEADLESS_CMD (the agent CLI, default claude),
# AGENT_HARNESS_RUNS_DIR (run folder, default <stateDir>/runs), AGENT_HARNESS_WORKTREE_DIR.
#
# Output: the RESULT line, cost_usd and num_turns when the JSON has them, and run_dir=<path>.
# Exit codes: 0 PROCEED, 1 ITERATE or BLOCKED, 2 a script or CLI error (agent CLI missing, bad input).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=${AGENT_HARNESS_ROOT:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}
export AGENT_HARNESS_ROOT=$root

usage() {
  echo "usage: scripts/agents/run-packet.sh <brief-path> <packet-id> [--model <m>] [--effort <e>] [--worktree] [--base <ref>] [--merge <ref>]... [--defer-verify] [--dry-run]" >&2
  exit 2
}

die() {
  echo "run-packet: $*" >&2
  exit 2
}

cfg() { node "$here/config-get.mjs" "$@" 2>/dev/null || true; }

extract_result() {
  # $1 result.json  $2 packet  $3 run dir
  node - "$1" "$2" "$3" <<'EOF'
const fs = require('fs');
const file = process.argv[2];
const packet = process.argv[3];
const runDir = process.argv[4];
const fail = (message) => {
  console.error(`run-packet: ${message} (run_dir=${runDir})`);
  process.exit(2);
};
let raw;
try {
  raw = fs.readFileSync(file, 'utf8');
} catch (e) {
  fail(`cannot read result.json: ${e.message}`);
}
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (e2) {
      fail(`result.json is not JSON: ${e2.message}`);
    }
  } else {
    fail(`result.json is not JSON: ${e.message}`);
  }
}
if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
  fail('result.json is not a JSON object');
}
if (typeof parsed.result !== 'string') fail('result.json has no string result field');
const escaped = packet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shape = new RegExp(
  `^RESULT ${escaped} (PROCEED|ITERATE|BLOCKED) rounds=(\\d+) report=(\\S+)$`,
);
const line = parsed.result
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => shape.test(s))
  .pop();
if (!line) fail(`no RESULT line for ${packet} in the result field`);
const verdict = shape.exec(line)[1];
const bits = [];
const cost =
  parsed.cost_usd != null
    ? parsed.cost_usd
    : parsed.total_cost_usd != null
      ? parsed.total_cost_usd
      : null;
if (cost != null) bits.push(`cost_usd=${cost}`);
if (parsed.num_turns != null) bits.push(`num_turns=${parsed.num_turns}`);
process.stdout.write(`${line}\n`);
if (bits.length) process.stdout.write(`${bits.join(' ')}\n`);
process.stdout.write(`run_dir=${runDir}\n`);
process.exit(verdict === 'PROCEED' ? 0 : 1);
EOF
}

check_ref() {
  # $1 flag name  $2 ref. Must be a local packet/ branch that exists.
  case "$2" in
    packet/* ) ;;
    *) die "$1 '$2' must match ^packet/" ;;
  esac
  case "$2" in
    *[[:space:]]* | *..* | *'~'* | *'^'* | *':'* | *'\\'*) die "bad $1 '$2'" ;;
  esac
  git -C "$root" rev-parse --verify --quiet "refs/heads/$2" >/dev/null \
    || die "$1 '$2': no such local branch"
}

install_command() {
  local custom pm
  custom=$(cfg harness.worktree.install)
  if [ -n "$custom" ]; then printf '%s\n' "$custom"; return; fi
  pm=$(cfg packageManager)
  case "$pm" in
    pnpm) echo "pnpm install --frozen-lockfile --prefer-offline" ;;
    npm) echo "npm ci" ;;
    yarn) echo "yarn install --frozen-lockfile" ;;
    bun) echo "bun install --frozen-lockfile" ;;
    *) echo "" ;;
  esac
}

setup_worktree() {
  # $1 wt dir  $2 branch  $3 feature  $4 base ref (default HEAD)  $5.. merge refs. Needs $root, $run.
  local wt="$1" branch="$2" feature="$3" base="${4:-HEAD}" p ref install handoff
  shift 4
  git -C "$root" worktree add "$wt" -b "$branch" "$base" >&2 || die "git worktree add failed"
  echo "BRANCH $branch"
  for ref in "$@"; do
    if ! git -C "$wt" merge --no-edit "$ref" >&2; then
      git -C "$wt" merge --abort >/dev/null 2>&1 || true
      git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true
      git -C "$root" branch -D "$branch" >/dev/null 2>&1 || true
      die "merge conflict merging $ref into $branch (worktree and branch removed)"
    fi
  done
  handoff=$(cfg paths.handoff docs/handoff)
  # Copy the agent setup (it may be untracked or ignored, so a fresh worktree would miss it).
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$p" in /* | *..*) continue ;; esac
    [ -e "$root/$p" ] || continue
    mkdir -p "$wt/$(dirname "$p")"
    rm -rf "${wt:?}/$p"
    cp -R "$root/$p" "$wt/$p"
  done < <(cfg harness.worktree.copy; echo "$handoff/$feature")
  install=$(install_command)
  if [ -n "$install" ]; then
    # A real install, not symlinks: symlinked dependency folders break many toolchains.
    (cd "$wt" && sh -c "$install") > "$run/install.log" 2>&1 \
      || die "install failed in $wt (see $run/install.log)"
  fi
}

packet_name() {
  # $1 brief file  $2 packet id. Prints the packet's `- **Name:**` line, or nothing.
  LC_ALL=C awk -v id="$2" '
    index($0, "### " id ". ") == 1 { on = 1; next }
    on && /^#/ { exit }
    on && /^- \*\*Name:\*\*/ { sub(/^- \*\*Name:\*\*[ \t]*/, ""); print; exit }
  ' "$1" 2>/dev/null | LC_ALL=C tr -d '\000-\037' | cut -c1-80 | sed 's/[[:space:]]*$//'
}

resolve_file() {
  # Print the absolute path of $1, relative to the caller's cwd or the repo root.
  local candidate="$1" dir base
  if [ -f "$candidate" ]; then
    dir=$(cd "$(dirname "$candidate")" && pwd)
    base=$(basename "$candidate")
    printf '%s/%s\n' "$dir" "$base"
    return 0
  fi
  if [ -f "$root/$candidate" ]; then
    dir=$(cd "$(dirname "$root/$candidate")" && pwd)
    base=$(basename "$candidate")
    printf '%s/%s\n' "$dir" "$base"
    return 0
  fi
  return 1
}

main() {
  local brief_in="" packet="" model="" dry=0 effort="" use_wt=0 base_ref="" merge_refs=() defer=${AGENT_HARNESS_DEFER_VERIFY:-0}
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1; shift ;;
      --worktree) use_wt=1; shift ;;
      --defer-verify) defer=1; shift ;;
      --base)
        [ $# -ge 2 ] || die "--base needs a value"
        [ -z "$base_ref" ] || die "--base given twice"
        base_ref=$2
        shift 2
        ;;
      --merge)
        [ $# -ge 2 ] || die "--merge needs a value"
        merge_refs+=("$2")
        shift 2
        ;;
      --effort)
        [ $# -ge 2 ] || die "--effort needs a value"
        effort=$2
        shift 2
        ;;
      --effort=*) effort=${1#--effort=}; shift ;;
      --model)
        [ $# -ge 2 ] || die "--model needs a value"
        model=$2
        shift 2
        ;;
      --model=*) model=${1#--model=}; shift ;;
      --) shift; break ;;
      -*) die "unknown option $1" ;;
      *)
        if [ -z "$brief_in" ]; then brief_in=$1
        elif [ -z "$packet" ]; then packet=$1
        else die "unexpected argument $1"
        fi
        shift
        ;;
    esac
  done
  [ -n "$brief_in" ] && [ -n "$packet" ] || usage
  case "$packet" in
    *[!A-Za-z0-9._-]*) die "bad packet id '$packet'" ;;
  esac
  [ -n "$model" ] || model=$(cfg harness.headless.model)
  [ -n "$effort" ] || effort=$(cfg harness.headless.effort)
  case "$model" in
    -* | *[[:space:]]*) die "bad model '$model'" ;;
  esac
  case "$effort" in
    '' | low | medium | high | xhigh | max) ;;
    *) die "bad effort '$effort' (low|medium|high|xhigh|max)" ;;
  esac

  if [ -n "$base_ref" ] || [ "${#merge_refs[@]}" -gt 0 ]; then
    [ "$use_wt" -eq 1 ] || die "--base/--merge need --worktree"
    [ -z "$base_ref" ] || check_ref --base "$base_ref"
    local mref
    for mref in ${merge_refs[@]+"${merge_refs[@]}"}; do check_ref --merge "$mref"; done
  fi
  local brief
  brief=$(resolve_file "$brief_in") || die "brief not found: $brief_in"
  local brief_base feature
  brief_base=$(basename "$brief")
  case "$brief_base" in
    *-build-brief.md) feature=${brief_base%-build-brief.md} ;;
    *) die "brief must be named <feature>-build-brief.md (got $brief_base)" ;;
  esac

  local state_dir slice run_root wt_root stamp run
  state_dir=${AGENT_HARNESS_STATE:-$root/$(cfg harness.stateDir .agent-harness)}
  slice="$(dirname "$brief")/$feature/$packet.md"
  run_root=${AGENT_HARNESS_RUNS_DIR:-$state_dir/runs}
  wt_root=${AGENT_HARNESS_WORKTREE_DIR:-$(cfg harness.worktree.dir)}
  [ -n "$wt_root" ] || wt_root="$state_dir/worktrees"
  case "$wt_root" in /*) ;; *) wt_root="$root/$wt_root" ;; esac
  stamp=$(date +%Y%m%d-%H%M%S)
  run="$run_root/${packet}-${stamp}"
  if [ -e "$run" ]; then run="${run}-$$"; fi

  local wt="" branch="" cwd_run brief_run slice_run
  cwd_run=$root
  if [ "$use_wt" -eq 1 ]; then
    wt="$wt_root/${packet}-wt"
    branch="packet/${packet}-${stamp}"
    cwd_run=$wt
    case "$brief" in "$root"/*) brief_run="$wt/${brief#"$root"/}" ;; *) brief_run=$brief ;; esac
    case "$slice" in "$root"/*) slice_run="$wt/${slice#"$root"/}" ;; *) slice_run=$slice ;; esac
  else
    brief_run=$brief
    slice_run=$slice
  fi

  # Headless command line.
  local cmd extra=() line
  cmd=${AGENT_HARNESS_HEADLESS_CMD:-$(cfg harness.headless.command)}
  [ -n "$cmd" ] || cmd=claude
  while IFS= read -r line; do [ -z "$line" ] || extra+=("$line"); done < <(cfg harness.headless.args)
  local opts=(--permission-mode acceptEdits --add-dir "$run" --output-format json)
  [ -z "$model" ] || opts+=(--model "$model")
  [ -z "$effort" ] || opts+=(--effort "$effort")

  # Role names and commands for the prompt.
  local prefix builder reviewer verify test_cmd
  prefix=$(cfg rolePrefix)
  builder=$(cfg harness.roles.builder "${prefix}builder")
  reviewer=$(cfg harness.roles.reviewer "${prefix}code-reviewer")
  verify=$(cfg commands.verify)
  test_cmd=$(cfg commands.test)

  local commit_rule
  if [ "$use_wt" -eq 1 ]; then
    commit_rule="Never push or deploy. Never commit on the main checkout. After reviewer PROCEED and the verify step passes, make one local commit on branch ${branch} with only this packet's scope paths (one-line subject). Do not commit the untracked agent-setup files copied into the worktree."
  else
    commit_rule="Never push, commit, or deploy."
  fi

  local pname title
  pname=$(packet_name "$brief" "$packet" || true)
  if [ -n "$pname" ]; then title="$pname ($packet)"; else title=$packet; fi

  local verify_note
  if [ "$defer" = 1 ]; then
    verify_note="OVERRIDE from the human: the full check runs once per finished flow, outside this run. Do NOT run ${verify:-the full verify command} or any whole-suite test run for this packet, and tell every subagent the same. Read the verify step as: only the tests for this packet's own files${test_cmd:+ (project test command: $test_cmd)}, plus the cheap checks, all exit 0. Whole-repo commands take turns with other sessions automatically: one that sits silent at the start is waiting for its turn, so do not cancel or retry it. Log the verify step as: deferred to flow end."
  else
    verify_note="The verify step is the full verify command${verify:+: $verify}. Run it once, after reviewer PROCEED."
  fi

  local prompt
  prompt=$(cat <<PROMPT
$title: Run the orchestrate skill for this one packet and nothing else. The skill is in the project at .agents/skills/orchestrate/SKILL.md, or installed as the plugin skill "orchestrate".

Packet: $packet
Brief: $brief_run
Slice: $slice_run
Scratch: $run

Use Scratch for every report and log. Follow every gate in the skill, in order: baseline snapshot (git stash create only), the ${builder} agent dispatched with the slice (not the spec or the brief), round checks, scope diff, honesty check of the builder report file, carry the deviations and CANNOT-VERIFY items from the builder report to the reviewer every round, a fresh ${reviewer} agent every round (never resume one), at most 3 rounds, the verify step once on PROCEED, node scripts/agents/log-round.mjs every round, and the state-file update.

Dispatch every subagent in the foreground (never in the background) and wait for its reply in the same turn. This is a headless session: ending a turn while a subagent runs ends the whole run with no RESULT line.

${commit_rule} Do not pass flags that skip permission checks. The project guard hooks apply. Any command that needs approval is refused at once: do not retry it or look for a way round it. Carry on where you can, and list each refused command under a DENIED heading in your final report so the human can decide.

PROCEED only after the verify step passes. ITERATE if the last round is ITERATE, including a third ITERATE that stops the feature. BLOCKED if you stop for a report mismatch, a guard denial, an unresolved slice, or a human decision. report= is the last review file, or the builder file if you stopped before review.

$verify_note

Finish with exactly one line and no text after it:
RESULT $packet PROCEED|ITERATE|BLOCKED rounds=<n> report=<path>
PROMPT
)

  if [ "$dry" -eq 1 ]; then
    if [ "$use_wt" -eq 1 ]; then
      printf 'plan: git -C %q worktree add %q -b %q %q\n' "$root" "$wt" "$branch" "${base_ref:-HEAD}"
      printf 'BRANCH %s\n' "$branch"
      for mref in ${merge_refs[@]+"${merge_refs[@]}"}; do
        printf 'plan: git -C %q merge --no-edit %q\n' "$wt" "$mref"
      done
      printf 'plan: copy the agent setup (harness.worktree.copy) and %s/%s into the worktree\n' "$(cfg paths.handoff docs/handoff)" "$feature"
      printf 'plan: install command in the worktree: %s\n' "$(install_command | sed 's/^$/(none)/')"
      printf 'plan: scripts/agents/clean-worktrees.sh first (removes merged, clean, unused packet worktrees)\n'
    fi
    printf 'cd %q && ' "$cwd_run"
    printf '%q ' "$cmd" ${extra[@]+"${extra[@]}"} -p "$prompt" "${opts[@]}"
    printf '> %q 2> %q\n' "$run/result.json" "$run/stderr.log"
    printf '\n--- prompt ---\n%s\n' "$prompt"
    exit 0
  fi

  command -v "$cmd" >/dev/null 2>&1 || die "agent CLI '$cmd' not available (set harness.headless.command or AGENT_HARNESS_HEADLESS_CMD)"
  cd "$root" || die "cannot cd $root"
  local slice_out
  # Write the slice (so it exists), then --check proves that file is current.
  if ! slice_out=$(node "$here/packet-slice.mjs" --brief "$brief" --packet "$packet" 2>&1); then
    printf '%s\n' "$slice_out" >&2
    die "slice failed for $packet - agent not started"
  fi
  if ! slice_out=$(node "$here/packet-slice.mjs" --brief "$brief" --packet "$packet" --check 2>&1); then
    printf '%s\n' "$slice_out" >&2
    die "slice missing or stale for $packet - agent not started"
  fi
  [ -f "$slice" ] || die "slice not found after check: $slice"
  local status
  status=$(sed -n '1,30s/^spec_status:[[:space:]]*//p' "$slice")
  if [ "$status" != "approved" ]; then
    die "$packet spec_status is '${status:-missing}', not approved - agent not started"
  fi

  mkdir -p "$run" || die "cannot create $run"
  if [ "$use_wt" -eq 1 ]; then
    # Free finished packet worktrees first (merged, clean, not in use). Never blocks this run.
    "$here/clean-worktrees.sh" --quiet >&2 || true
    [ ! -e "$wt" ] || die "worktree path exists: $wt"
    mkdir -p "$wt_root"
    setup_worktree "$wt" "$branch" "$feature" "${base_ref:-HEAD}" ${merge_refs[@]+"${merge_refs[@]}"}
    cd "$wt" || die "cannot cd $wt"
    echo "run-packet: worktree=$wt branch=$branch"
  fi
  local agent_ec extract_ec
  set +e
  AGENT_HARNESS_PACKET_WORKTREE=$([ "$use_wt" -eq 1 ] && echo "$wt") \
    "$cmd" ${extra[@]+"${extra[@]}"} -p "$prompt" "${opts[@]}" >"$run/result.json" 2>"$run/stderr.log"
  agent_ec=$?
  if [ "$agent_ec" -ne 0 ]; then
    echo "run-packet: agent exited $agent_ec (see $run/stderr.log)" >&2
  fi
  extract_result "$run/result.json" "$packet" "$run"
  extract_ec=$?
  set -e
  if [ "$use_wt" -eq 1 ]; then echo "worktree=$wt branch=$branch"; fi
  if [ "$defer" = 1 ]; then echo "full_check=deferred (once per finished flow, via scripts/bin/check-lane.sh)"; fi
  if [ "$agent_ec" -ne 0 ]; then exit 2; fi
  exit "$extract_ec"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
