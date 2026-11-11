#!/bin/sh
# scripts/bin/ram-ok.sh - one-word memory check before a heavy job. macOS and Linux.
#
#   scripts/bin/ram-ok.sh
#
# Prints "OK pressure=<level> free=<n>%" or "WAIT pressure=critical free=<n>%".
# Exit 0 for OK, 1 for WAIT. Levels (normal, warning, critical) come from the OS:
#   macOS  sysctl kern.memorystatus_vm_pressure_level (1 normal, 2 warning, 4 critical)
#   Linux  /proc/pressure/memory when present, else MemAvailable / MemTotal
# A missing probe counts as normal: the script prints "OK pressure=unknown" and exits 0.
# Env: AGENT_HARNESS_FORCE_PRESSURE=normal|warning|critical overrides the probe (tests).
level=""
free=""
if [ -n "${AGENT_HARNESS_FORCE_PRESSURE:-}" ]; then
  level=$AGENT_HARNESS_FORCE_PRESSURE
else
  case "$(uname -s 2>/dev/null)" in
    Darwin)
      raw=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 1)
      free=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/{gsub("%","",$2);print $2}')
      case "$raw" in 4) level=critical ;; 2) level=warning ;; *) level=normal ;; esac
      ;;
    Linux)
      if [ -r /proc/meminfo ]; then
        avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
        total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
        [ -n "$avail" ] && [ -n "$total" ] && [ "$total" -gt 0 ] && free=$((avail * 100 / total))
      fi
      if [ -r /proc/pressure/memory ]; then
        avg=$(sed -n 's/^some avg10=\([0-9]*\).*/\1/p' /proc/pressure/memory)
        if [ "${avg:-0}" -ge 40 ]; then level=critical
        elif [ "${avg:-0}" -ge 10 ]; then level=warning
        else level=normal; fi
      elif [ -n "$free" ]; then
        if [ "$free" -lt 5 ]; then level=critical
        elif [ "$free" -lt 10 ]; then level=warning
        else level=normal; fi
      fi
      ;;
  esac
fi
if [ -z "$level" ]; then
  echo "OK pressure=unknown free=?% (no memory probe on this system)"
  exit 0
fi
if [ "$level" = critical ]; then
  echo "WAIT pressure=critical free=${free:-?}%"
  exit 1
fi
echo "OK pressure=$level free=${free:-?}%"
exit 0
