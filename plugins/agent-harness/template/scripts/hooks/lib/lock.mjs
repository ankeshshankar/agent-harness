// scripts/hooks/lib/lock.mjs - a directory lock with stale-lock recovery. Not run on its own.
// acquire(lock) returns true when this process now holds the lock. A lock older than
// staleMs (default 30 s) is moved aside and replaced. Release with release(lock).
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';

export function acquire(lock, staleMs = 30_000) {
  const grab = () => mkdirSync(lock);
  try {
    grab();
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let mtimeMs;
  try {
    mtimeMs = statSync(lock).mtimeMs;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try {
      grab();
      return true;
    } catch (e2) {
      if (e2.code === 'EEXIST') return false;
      throw e2;
    }
  }
  if (Date.now() - mtimeMs < staleMs) return false;
  // Rename aside first so a racing process cannot have its fresh lock removed.
  const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, stale);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return false;
  }
  let movedMtime = 0;
  try {
    movedMtime = statSync(stale).mtimeMs;
  } catch {
    // gone already
  }
  if (Date.now() - movedMtime < staleMs) {
    // We moved a live lock that someone just took: put it back and stand down.
    try {
      renameSync(stale, lock);
    } catch {
      // nothing more to do
    }
    return false;
  }
  rmSync(stale, { recursive: true, force: true });
  try {
    grab();
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

export function release(lock) {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    // already gone
  }
}
