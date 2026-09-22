// Registry of in-flight runtime CLI children (process-group leaders).
//
// The dashboard's systemd unit uses KillMode=process (a control-group kill
// would also take the tmux fleet down), so a dashboard restart leaves every
// in-flight `claude -p` / `codex exec` / `mcode exec` running with nobody
// watching its timeout -- and the re-queued work can run twice. The registry
// is mirrored to store/runtime-children.json; on the next boot
// reapOrphanedChildren() terminates the groups a previous process left behind,
// after checking that the pid still belongs to the same binary (pid reuse).

import { readFileSync, existsSync, readdirSync } from 'node:fs'
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

// A group whose leader already exited can still hold members (a tool's
// `sleep`, an MCP server). The leader's pid cannot vouch for them any more, so
// they are reaped only while the entry is young enough that the pgid cannot
// plausibly have been recycled by an unrelated group leader.
export const MAX_ORPHAN_AGE_MS = 2 * 60 * 60 * 1000

export type ReapAction = { entry: ChildEntry; how: 'leader' | 'members' }

/** Pure: which recorded children (or their surviving groups) should be reaped now? */
export function orphansToReap(
  entries: ChildEntry[],
  ownerPid: number,
  deps: { isAlive: (pid: number) => boolean; cmdline: (pid: number) => string | null; groupMembers?: (pgid: number) => number[]; now?: number },
): ChildEntry[] {
  return reapPlan(entries, ownerPid, deps).map((a) => a.entry)
}

export function reapPlan(
  entries: ChildEntry[],
  ownerPid: number,
  deps: { isAlive: (pid: number) => boolean; cmdline: (pid: number) => string | null; groupMembers?: (pgid: number) => number[]; now?: number },
): ReapAction[] {
  const out: ReapAction[] = []
  const now = deps.now ?? Date.now()
  for (const e of entries) {
    if (!e || !Number.isInteger(e.pid) || e.pid <= 1) continue
    if (e.owner === ownerPid) continue // ours, still tracked
    if (deps.isAlive(e.owner)) continue // its dashboard is still running (another install/process)
    if (deps.isAlive(e.pid)) {
      const cmd = deps.cmdline(e.pid)
      const base = e.bin.split('/').pop() ?? e.bin
      if (cmd && cmd.includes(base)) out.push({ entry: e, how: 'leader' }) // pid reuse guard
      continue
    }
    if (now - e.startedAt < MAX_ORPHAN_AGE_MS && (deps.groupMembers?.(e.pid) ?? []).length) out.push({ entry: e, how: 'members' })
  }
  return out
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Live processes whose process group id is `pgid` (Linux /proc; empty elsewhere). */
function procGroupMembers(pgid: number): number[] {
  const out: number[] = []
  let names: string[] = []
  try { names = readdirSync('/proc') } catch { return out }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    try {
      const stat = readFileSync(`/proc/${n}/stat`, 'utf-8')
      // pid (comm) state ppid pgrp ... -- comm may contain spaces/parens: parse after the last ')'
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(rest[2]) === pgid) out.push(Number(n))
    } catch { /* raced */ }
  }
  return out
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
  const plan = reapPlan(Array.isArray(entries) ? entries : [], process.pid, { isAlive: pidAlive, cmdline: procCmdline, groupMembers: procGroupMembers })
  const victims = plan.map((a) => a.entry)
  for (const { entry: v, how } of plan) {
    try { process.kill(-v.pid, 'SIGTERM') } catch { try { if (how === 'leader') process.kill(v.pid, 'SIGTERM') } catch { /* gone */ } }
    setTimeout(() => { try { process.kill(-v.pid, 'SIGKILL') } catch { /* gone */ } }, 5_000).unref()
    logger.warn({ pid: v.pid, how, runtime: v.label, agent: v.agentId, startedAt: new Date(v.startedAt).toISOString() }, 'child-registry: reaped an orphaned runtime process group from a previous dashboard run')
  }
  // Start this process's registry clean.
  try { atomicWriteFileSync(p, JSON.stringify(liveChildren(), null, 2) + '\n') } catch { /* best effort */ }
  return victims.length
}
