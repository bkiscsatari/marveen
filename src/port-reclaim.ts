// Port reclaim guard: which process holding the dashboard port may be killed.
//
// The reclaim used to accept any node/tsx process of the same user. On a host
// that runs a dev clone next to the live install, a clone started without its
// own WEB_PORT reclaimed 3420 by SIGTERM-ing the LIVE dashboard (measured
// 2026-09-22: 5 minutes down, not restarted by Restart=on-failure). Now the
// holder must be a process whose working directory is THIS install.

import { readlinkSync, realpathSync } from 'node:fs'
import { runLsof } from './lsof.js'

/** The working directory of a pid: /proc on Linux, lsof elsewhere; null when unknown. */
export function processCwd(pid: number): string | null {
  try { return readlinkSync(`/proc/${pid}/cwd`) } catch { /* not Linux, or gone */ }
  try {
    const out = runLsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], 3000) ?? ''
    const line = out.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  } catch { return null }
}

function canon(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** Pure decision: may the holder with this cwd be reclaimed by the install at projectRoot? */
export function portReclaimAllowed(holderCwd: string | null, projectRoot: string): { ok: boolean; reason: string } {
  if (!holderCwd) return { ok: false, reason: 'holder cwd unknown -- not provably ours' }
  const a = canon(holderCwd).replace(/\/+$/, '')
  const b = canon(projectRoot).replace(/\/+$/, '')
  if (a === b) return { ok: true, reason: 'same install' }
  return { ok: false, reason: `holder runs from ${a}, this install is ${b}` }
}
