#!/usr/bin/env bash
# scripts/agents/clean-worktrees.sh - remove finished packet worktrees.
#
#   scripts/agents/clean-worktrees.sh [--dry-run] [--quiet]
#
# run-packet.sh --worktree calls this before it creates a new worktree, so disk use does not grow.
# A packet worktree (branch packet/*, folder *-wt) is removed only when ALL of these hold:
#   1. merged: its HEAD commit is on a local branch that is not packet/*;
#   2. no uncommitted tracked change outside the state file and the handoff folder;
#   3. no untracked file outside the copied agent setup, except *.bak / *.orig / *.x leftovers;
#   4. no running process has its working directory inside it (checked with lsof, or /proc on Linux;
#      when neither exists this check is skipped and says so);
#   5. it is older than CLEAN_WT_MIN_AGE_MIN minutes (default 60), so a run that is just starting is
#      never touched.
# Before removal the uncommitted state-file / handoff diff is saved as a patch under
# <stateDir>/removed-worktrees/<date>/. The branch is always kept.
# Config: paths.state (default STATE.md), paths.handoff (default docs/handoff), harness.worktree.copy
# (the copied setup paths, see run-packet.sh). Env: CLEAN_WT_MIN_AGE_MIN, AGENT_HARNESS_ROOT.
# Never fails the caller: always exits 0.
set -uo pipefail

dry=0 quiet=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --quiet) quiet=1 ;;
    *) echo "usage: scripts/agents/clean-worktrees.sh [--dry-run] [--quiet]" >&2; exit 0 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
root=${AGENT_HARNESS_ROOT:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}
cfg() { AGENT_HARNESS_ROOT=$root node "$here/config-get.mjs" "$@" 2>/dev/null; }
min_age=${CLEAN_WT_MIN_AGE_MIN:-60}
state_dir=${AGENT_HARNESS_STATE:-$root/$(cfg harness.stateDir .agent-harness)}
backup="$state_dir/removed-worktrees/$(date +%Y-%m-%d)"
state_file=$(cfg paths.state STATE.md)
handoff=$(cfg paths.handoff docs/handoff)
esc() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|/]/\\&/g'; }
copy_re=$(cfg harness.worktree.copy ".agents
.claude
.cursor
.codex
AGENTS.md
CLAUDE.md
agents.config.json
scripts" | while IFS= read -r p; do [ -n "$p" ] && printf '%s|' "$(esc "$p")"; done)
setup="^(${copy_re}$(esc "$handoff")/)"
tracked_ok="^($(esc "$state_file")$|$(esc "$handoff")/)"
say() { [ "$quiet" -eq 1 ] || echo "$*"; }

# Working directory of every running process: paths only, never command lines.
cwds=""
cwd_known=1
if command -v lsof >/dev/null 2>&1; then
  cwds=$(lsof -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u)
elif [ -d /proc/self ]; then
  cwds=$(for l in /proc/[0-9]*/cwd; do readlink "$l" 2>/dev/null; done | sort -u)
else
  cwd_known=0
  say "note: no lsof and no /proc, so the in-use check is skipped"
fi
now=$(date +%s)
removed=0 kept=0

birth() { # creation time in seconds; falls back to modification time
  stat -f %B "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo "$now"
}

wt="" branch=""
flush() {
  local p="$wt" b="$branch" reason="" born age other work tag
  wt="" branch=""
  [ -n "$p" ] || return 0
  case "$b" in packet/*) ;; *) return 0 ;; esac
  case "$p" in *-wt) ;; *) return 0 ;; esac
  [ "$p" != "$root" ] && [ -e "$p/.git" ] || return 0

  born=$(birth "$p")
  age=$(((now - born) / 60))
  work=$(git -C "$p" status --porcelain --untracked-files=no 2>/dev/null | cut -c4- | grep -cvE "$tracked_ok")
  other=$(git -C "$p" status --porcelain --untracked-files=all 2>/dev/null | sed -n 's/^?? //p' | grep -vE "$setup" | grep -cvE '\.(bak|orig|x)$')
  if [ "$age" -lt "$min_age" ]; then reason="younger than ${min_age} min"
  elif [ "$cwd_known" -eq 1 ] && printf '%s\n' "$cwds" | grep -qE "^$(esc "$p")(/|$)"; then reason="in use"
  elif [ "$work" -gt 0 ]; then reason="$work uncommitted file(s)"
  elif [ "$other" -gt 0 ]; then reason="$other untracked file(s)"
  elif ! git -C "$root" for-each-ref --contains "$(git -C "$p" rev-parse HEAD)" --format='%(refname:short)' refs/heads 2>/dev/null | grep -qv '^packet/'; then reason="not merged"
  fi
  if [ -n "$reason" ]; then
    kept=$((kept + 1))
    say "keep   $(basename "$p")  ($reason)"
    return 0
  fi
  if [ "$dry" -eq 1 ]; then
    removed=$((removed + 1))
    say "remove $(basename "$p")  (dry run)"
    return 0
  fi
  mkdir -p "$backup"
  tag=$(basename "$p")__${b#packet/}
  tag=${tag//\//_}
  git -C "$p" diff HEAD >"$backup/$tag.patch" 2>/dev/null
  [ -s "$backup/$tag.patch" ] || rm -f "$backup/$tag.patch"
  if git -C "$root" worktree remove --force "$p" >/dev/null 2>&1 && [ ! -e "$p" ]; then
    removed=$((removed + 1))
    say "remove $(basename "$p")"
  else
    kept=$((kept + 1))
    say "keep   $(basename "$p")  (git worktree remove failed)"
  fi
}

while IFS= read -r line; do
  case "$line" in
    "worktree "*) flush; wt=${line#worktree } ;;
    "branch refs/heads/"*) branch=${line#branch refs/heads/} ;;
  esac
done < <(git -C "$root" worktree list --porcelain 2>/dev/null)
flush
git -C "$root" worktree prune >/dev/null 2>&1 || true

echo "clean-worktrees: removed=$removed kept=$kept$([ "$dry" -eq 1 ] && echo ' (dry run)')"
exit 0
