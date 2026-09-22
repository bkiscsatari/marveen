// A dashboard may reclaim its port only from ITS OWN install's process -- never
// from the live dashboard when a dev clone starts on the live port.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { portReclaimAllowed, processCwd } from '../port-reclaim.js'

describe('portReclaimAllowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'marveen-port-'))
  const live = join(root, 'marveen'); const clone = join(root, 'marveen-agnostic')
  mkdirSync(live); mkdirSync(clone)
  symlinkSync(live, join(root, 'live-link'))

  it('same install (also through a symlink): allowed', () => {
    expect(portReclaimAllowed(live, live).ok).toBe(true)
    expect(portReclaimAllowed(join(root, 'live-link'), live).ok).toBe(true)
    expect(portReclaimAllowed(`${live}/`, live).ok).toBe(true)
  })
  it('another install, a prefix-alike path, or an unknown cwd: refused', () => {
    expect(portReclaimAllowed(live, clone).ok).toBe(false)
    expect(portReclaimAllowed(clone, live).ok).toBe(false)
    expect(portReclaimAllowed(null, live).ok).toBe(false)
  })
  it('reads the cwd of a live process', () => {
    expect(processCwd(process.pid)).toBe(process.cwd())
  })
})
