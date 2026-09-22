// One process runner and one session-chain implementation for every
// JSONL-streaming CLI adapter (claude-headless, codex-cli, gemini-cli,
// minimax-cli).
//
// The four adapters each carried a ~90% identical copy of this code, and the
// copies had drifted: only some handled stdin EPIPE, one used a different
// timer, some recorded usage on blocked runs and some did not. The shared
// parts that are easy to get wrong live here once:
//   - the child runs in its OWN process group (detached) and a timeout or an
//     abort signals the whole group -- MCP servers and tool grandchildren die
//     with it instead of outliving the run;
//   - completion does not depend on 'close' alone: a grandchild that inherited
//     the stdout pipe can keep it open forever, so 'exit' + a short grace, and
//     a hard cap, also end the wait;
//   - a result that arrived just before the timer fired wins over the timeout;
//   - one apology text, one usage policy (a blocked run still spent tokens).
//
// Pure-ish: I/O is the child process only; the adapters keep args, env,
// bundle rendering and their stream parser.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import { registerChild, unregisterChild } from './child-registry.js'
import type { AgentHandle, AgentSpec, AgentState, RunOptions, RunResult, RuntimeKind, SendOptions, SendOutcome, UsageCursor, UsageRecord } from './types.js'

export const KILL_GRACE_MS = 5_000
const EXIT_DRAIN_MS = 2_000

export interface JsonlCliRun {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written to stdin, then stdin is closed ('' closes it at once). */
  stdin: string
  timeoutMs: number
  onLine: (line: string) => void
  /** External abort (operator stop): ends the run like a timeout, but reported as aborted. */
  signal?: AbortSignal
  /** For logs and the child registry: e.g. 'codex-cli'. */
  label: string
  agentId: string
  killGraceMs?: number
}

export interface JsonlCliOutcome {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stderrTail: string
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return
  try { process.kill(-pid, sig) } catch {
    try { process.kill(pid, sig) } catch { /* already gone */ }
  }
}

export function runJsonlCli(o: JsonlCliRun): Promise<JsonlCliOutcome> {
  const grace = o.killGraceMs ?? KILL_GRACE_MS
  return new Promise((resolve) => {
    let stderrTail = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let child: ChildProcessWithoutNullStreams
    const timers: NodeJS.Timeout[] = []
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      o.signal?.removeEventListener('abort', onAbort)
      unregisterChild(child?.pid)
      resolve({ exitCode: code, timedOut, aborted, stderrTail })
    }
    const terminate = (why: 'timeout' | 'abort') => {
      if (settled) return
      if (why === 'timeout') timedOut = true
      else aborted = true
      logger.warn({ agent: o.agentId, runtime: o.label, why, timeoutMs: o.timeoutMs }, `${o.label}: run ${why === 'timeout' ? 'timed out' : 'aborted'}, terminating the process group`)
      killGroup(child?.pid, 'SIGTERM')
      const k = setTimeout(() => killGroup(child?.pid, 'SIGKILL'), grace)
      k.unref()
      // Hard cap: even a wedged pipe cannot keep the caller waiting.
      const cap = setTimeout(() => { try { child?.stdout.destroy(); child?.stderr.destroy() } catch { /* gone */ } finish(null) }, grace + EXIT_DRAIN_MS + 1_000)
      cap.unref()
      timers.push(k, cap)
    }
    const onAbort = () => terminate('abort')
    try {
      child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, detached: true }) as ChildProcessWithoutNullStreams
    } catch (err) {
      stderrTail = `spawn failed: ${(err as Error).message}`
      resolve({ exitCode: null, timedOut: false, aborted: false, stderrTail })
      return
    }
    registerChild(child.pid, { label: o.label, agentId: o.agentId, bin: o.bin })
    if (o.signal) {
      if (o.signal.aborted) queueMicrotask(onAbort)
      else o.signal.addEventListener('abort', onAbort, { once: true })
    }
    timers.push(setTimeout(() => terminate('timeout'), o.timeoutMs))
    createInterface({ input: child.stdout }).on('line', (line) => {
      try { o.onLine(line) } catch (err) { logger.debug({ err, runtime: o.label }, 'cli-process: line handler threw') }
    })
    child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000) })
    child.on('error', (err) => { stderrTail += ` spawn error: ${err.message}`; finish(null) })
    child.on('exit', (code) => {
      // 'close' normally follows; if a grandchild holds the pipe it may not.
      const t = setTimeout(() => { try { child.stdout.destroy(); child.stderr.destroy() } catch { /* gone */ } finish(code) }, EXIT_DRAIN_MS)
      t.unref()
      timers.push(t)
    })
    child.on('close', (code) => finish(code))
    child.stdin.on('error', () => { /* EPIPE when the CLI exits before reading stdin */ })
    child.stdin.end(o.stdin)
  })
}

/** The historical runAgent contract: a human-facing apology as text on timeout. */
export function timeoutApology(mins: number): string {
  return `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`
}

/**
 * Apply the shared timeout/abort semantics to a parsed result. A run that
 * produced a real answer right before the timer fired keeps it.
 */
export function finalizeRunResult(result: RunResult, out: JsonlCliOutcome, opts: { timeoutMs: number; timeoutAsError?: boolean }): RunResult {
  if (out.aborted) return { ...result, text: null, blocked: true, reason: 'aborted (stopped by the operator)' }
  if (!out.timedOut) return result
  if (result.text && !result.blocked) return result
  const mins = Math.round(opts.timeoutMs / 60000)
  return opts.timeoutAsError
    ? { ...result, text: null, blocked: true, reason: `timeout after ${mins}min` }
    : { ...result, text: timeoutApology(mins), blocked: false }
}

/** Usage is recorded whenever the stream reported it -- a blocked run still spent tokens. */
export async function recordUsageBestEffort(agentId: string, result: RunResult, prompt: string, label: string): Promise<void> {
  if (!result.usage) return
  try {
    const { recordRuntimeUsage } = await import('./usage-sink.js')
    recordRuntimeUsage(agentId, result.usage, { contentPreview: prompt.slice(0, 200) })
  } catch (err) {
    logger.debug({ err }, `${label}: usage sink unavailable (skipped)`)
  }
}

// --- long-lived handles: one resume-chain implementation --------------------

export type ChainRun = (spec: AgentSpec, prompt: string, opts: RunOptions) => Promise<RunResult>

interface ChainSession {
  spec: AgentSpec
  sessionId: string | null
  chain: Promise<unknown>
  inFlight: number
  lastResult: RunResult | null
  usage: UsageRecord[]
  abort: AbortController
}

/**
 * spawn/send/state/stop/usageSince for a headless CLI whose "session" is a
 * chain of one-shot runs linked by a resume id. Replaces four hand-copied
 * session maps. stop() now ENDS the in-flight run (process group) instead of
 * letting it finish unobserved.
 */
export class ResumeChainSessions {
  private readonly sessions = new Map<string, ChainSession>()

  constructor(
    private readonly kind: RuntimeKind,
    private readonly prefix: string,
    private readonly run: ChainRun,
    private readonly isAuthFailure: (r: RunResult) => boolean,
    private readonly isRateLimited: (r: RunResult) => boolean = (r) => /rate.?limit|429|quota|usage limit|RESOURCE_EXHAUSTED/i.test(r.reason ?? ''),
  ) {}

  async spawn(agent: AgentSpec, opts: { fresh?: boolean } = {}): Promise<AgentHandle> {
    const ref = `${this.prefix}:${agent.id}:${randomBytes(4).toString('hex')}`
    let prior: string | null = null
    if (!opts.fresh) {
      for (const [k, s] of this.sessions) if (s.spec.id === agent.id) { if (s.sessionId) prior = s.sessionId; this.sessions.delete(k) }
    }
    this.sessions.set(ref, { spec: agent, sessionId: prior, chain: Promise.resolve(), inFlight: 0, lastResult: null, usage: [], abort: new AbortController() })
    return { agentId: agent.id, runtime: this.kind, sessionRef: ref, host: null }
  }

  async send(handle: AgentHandle, prompt: string, opts: SendOptions = {}): Promise<SendOutcome> {
    const s = this.sessions.get(handle.sessionRef)
    if (!s) throw new Error(`${this.kind}: unknown handle ${handle.sessionRef}`)
    if (opts.onBusyTimeout === 'abort' && s.inFlight > 0) return 'aborted-busy'
    s.inFlight++
    s.chain = s.chain.then(async () => {
      if (s.abort.signal.aborted) return
      const r = await this.run(s.spec, prompt, { resume: s.sessionId ?? undefined, allowTools: true, timeoutAsError: true, signal: s.abort.signal })
      s.lastResult = r
      if (r.sessionRef) s.sessionId = r.sessionRef
      if (r.usage) s.usage.push(r.usage)
    }).catch((err) => {
      logger.error({ err, agent: s.spec.id, runtime: this.kind }, `${this.kind}: send failed`)
    }).finally(() => { s.inFlight-- })
    return 'sent'
  }

  async state(handle: AgentHandle): Promise<AgentState> {
    const s = this.sessions.get(handle.sessionRef)
    if (!s) return 'dead'
    if (s.inFlight > 0) return 'busy'
    if (s.lastResult?.blocked && this.isAuthFailure(s.lastResult)) return 'auth'
    if (s.lastResult?.blocked && this.isRateLimited(s.lastResult)) return 'blocked'
    return 'idle'
  }

  async stop(handle: AgentHandle): Promise<void> {
    const s = this.sessions.get(handle.sessionRef)
    if (!s) return
    this.sessions.delete(handle.sessionRef)
    s.abort.abort()
  }

  async usageSince(handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }> {
    const all = this.sessions.get(handle.sessionRef)?.usage ?? []
    const from = typeof cursor?.value === 'number' ? cursor.value : 0
    return { records: all.slice(from), cursor: { value: all.length } }
  }
}
