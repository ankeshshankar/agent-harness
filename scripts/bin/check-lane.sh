#!/bin/sh
# scripts/bin/check-lane.sh - run one whole-repo job (full check, typecheck, native build) in the shared lane.
#
#   scripts/bin/check-lane.sh <label> [--dir <dir>] -- <command...>
#
# Waits for its turn: one lane job at a time across every session and script that uses this project
# folder, first come first served (scripts/hooks/heavy-gate.mjs holds the lane; it also holds while
# memory pressure is critical). Then runs the command in <dir> (default: here), sends all output to
# a log, and prints one summary line plus the log's tail when the command failed.
# Without node, or with AGENT_HARNESS_HEAVY_GATE=off, the command runs at once ("lane gate not
# available, running without it" on stderr).
# From a chat, start it in the background; the chat carries on and is told when it ends.
#
# Exit code: the command's exit code; 2 for a usage error.
# Env: AGENT_HARNESS_ROOT (default CLAUDE_PROJECT_DIR, else the git top level, else here) is the project;
#      AGENT_HARNESS_STATE (default <project>/.agent-harness) holds the logs in lane/runs/.
#      Logs older than 7 days are removed. See scripts/hooks/heavy-gate.mjs for the wait settings.
set -u

usage() {
  echo "usage: check-lane.sh <label> [--dir <dir>] -- <command...>" >&2
  exit 2
}

[ $# -ge 3 ] || usage
label=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
shift
dir=$PWD
if [ "$1" = "--dir" ]; then
  [ $# -ge 4 ] || usage
  dir=$2
  shift 2
fi
[ "$1" = "--" ] || usage
shift
[ $# -ge 1 ] || usage
[ -d "$dir" ] || { echo "check-lane: no such directory: $dir" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
gate="$here/../hooks/heavy-gate.mjs"
root=${AGENT_HARNESS_ROOT:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}
state=${AGENT_HARNESS_STATE:-$root/.agent-harness}
out="$state/lane/runs"
mkdir -p "$out"
find "$out" -type f -mtime +7 -delete 2>/dev/null # own logs only

use_gate=1
if ! command -v node >/dev/null 2>&1 || [ ! -f "$gate" ] || [ "${AGENT_HARNESS_HEAVY_GATE:-}" = off ]; then
  use_gate=0
  [ "${AGENT_HARNESS_HEAVY_GATE:-}" = off ] || echo "check-lane: lane gate not available, running without it" >&2
fi

id="$label-$(date +%Y%m%d-%H%M%S)-$$"
log="$out/$id.log"
t0=$(date +%s)
if [ "$use_gate" -eq 1 ]; then
  # The lane is held while this script's pid lives, so a crash or kill frees it without cleanup.
  AGENT_HARNESS_ROOT=$root AGENT_HARNESS_STATE=$state node "$gate" lane-pre "$id" "$$" </dev/null
  trap 'AGENT_HARNESS_ROOT=$root AGENT_HARNESS_STATE=$state node "$gate" lane-post "$id" </dev/null' EXIT
fi
trap 'exit 143' TERM INT
t1=$(date +%s)
(cd "$dir" && "$@") >"$log" 2>&1
ec=$?
t2=$(date +%s)
printf '{"label":"%s","exit":%s,"waited_s":%s,"ran_s":%s,"log":"%s"}\n' \
  "$label" "$ec" "$((t1 - t0))" "$((t2 - t1))" "$log" >"$out/$id.json"
printf 'LANE %s exit=%s waited=%ss ran=%ss log=%s\n' "$label" "$ec" "$((t1 - t0))" "$((t2 - t1))" "$log"
[ "$ec" -eq 0 ] || tail -n 25 "$log"
exit "$ec"
