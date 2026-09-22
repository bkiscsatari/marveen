// Registry of in-flight runtime CLI children (process-group leaders).
//
// The dashboard's systemd unit uses KillMode=process (a control-group kill
// would also take the tmux fleet down), so a dashboard restart leaves every
// in-flight `claude -p` / `codex exec` / `mcode exec` running with nobody
// watching its timeout -- and the re-queued work can run twice. The registry
// is mirrored to store/runtime-children.json; on the next boot
// reapOrphanedChildren() terminates the groups a previous process left behind,
// after checking that the pid still belongs to the same binary (pid reuse).

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { logger } from '../logger.js'

export interface ChildEntry { pid: number; label: string; agentId: string; bin: string; startedAt: number; owner: number }

const live = new Map<number, ChildEntry>()
let registryPath: string | null = null

/** Enable persistence (called once by the dashboard boot with the store dir). */
export function initChildRegistry(storeDir: string): void {
  registryPath = join(storeDir, 'runtime-children.json')
}

function persist(): void {
  if (!registryPath) return
  try { atomicWriteFileSync(registryPath, JSON.stringify([...live.values()], null, 2) + '\n') }
  catch (err) { logger.debug({ err }, 'child-registry: persist failed') }
}

export function registerChild(pid: number | undefined, info: { label: string; agentId: string; bin: string }): void {
  if (!pid) return
  live.set(pid, { pid, ...info, startedAt: Date.now(), owner: process.pid })
  persist()
}

export function unregisterChild(pid: number | undefined): void {
  if (!pid || !live.delete(pid)) return
  persist()
}

export function liveChildren(): ChildEntry[] { return [...live.values()] }

/** Pure: which recorded children should be reaped now? */
export function orphansToReap(entries: ChildEntry[], ownerPid: number, deps: { isAlive: (pid: number) => boolean; cmdline: (pid: number) => string | null }): ChildEntry[] {
  return entries.filter((e) => {
    if (!e || !Number.isInteger(e.pid) || e.pid <= 1) return false
    if (e.owner === ownerPid) return false // ours, still tracked
    if (deps.isAlive(e.owner)) return false // its dashboard is still running (another install/process)
    if (!deps.isAlive(e.pid)) return false
    const cmd = deps.cmdline(e.pid)
    const base = e.bin.split('/').pop() ?? e.bin
    return !!cmd && cmd.includes(base) // pid reuse guard
  })
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

function procCmdline(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ') } catch { return null }
}

/** Boot-time: terminate the process groups a previous dashboard process left running. */
export function reapOrphanedChildren(storeDir: string): number {
  const p = join(storeDir, 'runtime-children.json')
  if (!existsSync(p)) return 0
  let entries: ChildEntry[] = []
  try { entries = JSON.parse(readFileSync(p, 'utf-8')) as ChildEntry[] } catch { entries = [] }
  const victims = orphansToReap(Array.isArray(entries) ? entries : [], process.pid, { isAlive: pidAlive, cmdline: procCmdline })
  for (const v of victims) {
    try { process.kill(-v.pid, 'SIGTERM') } catch { try { process.kill(v.pid, 'SIGTERM') } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-v.pid, 'SIGKILL') } catch { /* gone */ } }, 5_000).unref()
    logger.warn({ pid: v.pid, runtime: v.label, agent: v.agentId, startedAt: new Date(v.startedAt).toISOString() }, 'child-registry: reaped an orphaned runtime process group from a previous dashboard run')
  }
  // Start this process's registry clean.
  try { atomicWriteFileSync(p, JSON.stringify(liveChildren(), null, 2) + '\n') } catch { /* best effort */ }
  return victims.length
}
