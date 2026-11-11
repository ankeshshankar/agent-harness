// scripts/hooks/lib/memory.mjs - memory pressure as one word. Not run on its own.
// pressure() returns { level: 'normal' | 'warning' | 'critical', freePct: number | null }.
//   macOS  sysctl kern.memorystatus_vm_pressure_level (1 normal, 2 warning, 4 critical)
//   Linux  /proc/pressure/memory (PSI "some avg10") when present, else MemAvailable / MemTotal
//   other, or a failed read: normal (never blocks work because a probe is missing)
// AGENT_HARNESS_FORCE_PRESSURE=normal|warning|critical overrides the probe (tests, CI).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, platform, totalmem } from 'node:os';

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

export function pressure() {
  const forced = process.env.AGENT_HARNESS_FORCE_PRESSURE;
  if (forced === 'normal' || forced === 'warning' || forced === 'critical') {
    return { level: forced, freePct: null };
  }
  try {
    if (platform() === 'darwin') {
      const raw = Number(run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim());
      const pct = Number(run('memory_pressure', ['-Q']).match(/free percentage:\s*(\d+)/)?.[1]);
      const level = raw >= 4 ? 'critical' : raw === 2 ? 'warning' : 'normal';
      return { level, freePct: Number.isFinite(pct) ? pct : null };
    }
    if (platform() === 'linux') {
      let level = null;
      try {
        const psi = readFileSync('/proc/pressure/memory', 'utf8').match(/some avg10=([\d.]+)/);
        if (psi) {
          const avg = Number(psi[1]);
          level = avg >= 40 ? 'critical' : avg >= 10 ? 'warning' : 'normal';
        }
      } catch {
        // no PSI on this kernel
      }
      let freePct = null;
      try {
        const info = readFileSync('/proc/meminfo', 'utf8');
        const avail = Number(info.match(/MemAvailable:\s+(\d+)/)?.[1]);
        const total = Number(info.match(/MemTotal:\s+(\d+)/)?.[1]);
        if (avail && total) freePct = Math.round((avail / total) * 100);
      } catch {
        freePct = Math.round((freemem() / totalmem()) * 100);
      }
      if (!level) level = freePct === null ? 'normal' : freePct < 5 ? 'critical' : freePct < 10 ? 'warning' : 'normal';
      return { level, freePct };
    }
  } catch {
    // fall through
  }
  return { level: 'normal', freePct: null };
}
