// Headless session agents after the 2026-09-23 hardening: a 'sent' turn is
// journalled and survives a crash, a stop aborts the in-flight CLI run, the
// readiness gate counts queued turns, the queue is bounded, auth/quota blocks
// defer the turn instead of dropping it, and the turn log rotates + scrubs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRuntime, resetRuntimeRegistry } from '../runtime/registry.js'
import type { AgentRuntime, AgentSpec, RunOptions, RunResult } from '../runtime/types.js'
import {
  _setHeadlessDepsForTest, headlessInfo, headlessReady, readJournal, readHeadlessTurnLog, sendToHeadlessAgent,
  startHeadlessAgent, stopHeadlessAgent, INTERRUPTED_NOTE, MAX_QUEUED_TURNS, LOG_ROTATE_BYTES,
} from '../web/headless-agents.js'

function spec(): AgentSpec {
  return { id: 'scout', dir: '/tmp/scout', role: 'sub', model: 'minimax-m3', runtime: 'minimax-cli', provider: 'minimax', authMode: 'subscription', securityProfile: 'researcher', displayName: 'Scout' }
}

function runtime(run: (prompt: string, opts: RunOptions) => Promise<RunResult>): AgentRuntime {
  return {
    kind: 'minimax-cli',
    capabilities: () => ({ interactive: false, supportsResume: true, supportsHooks: 'native', supportsMcp: true, supportsChannelsPlugin: false, reportsUsage: 'events', contextWindow: 1 }),
    spawn: async () => { throw new Error('unused') }, send: async () => { throw new Error('unused') },
    run: async (_a, prompt, opts = {}) => run(prompt, opts),
    state: async () => 'idle', stop: async () => {}, usageSince: async () => ({ records: [], cursor: { value: 0 } }),
    healthProbe: async () => ({ ok: true, detail: '' }),
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return; await wait(5) }
  throw new Error('condition not reached')
}

let storeDir: string
beforeEach(() => { storeDir = mkdtempSync(join(tmpdir(), 'headless-dur-')); resetRuntimeRegistry() })
afterEach(() => { _setHeadlessDepsForTest(null); resetRuntimeRegistry(); rmSync(storeDir, { recursive: true, force: true }) })

describe('durable turn journal', () => {
  it('a turn is journalled before "sent" and removed when it completes', async () => {
    let release!: () => void
    registerRuntime(runtime(() => new Promise((r) => { release = () => r({ text: 'done', blocked: false, sessionRef: 's1' }) })))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    expect(await sendToHeadlessAgent('scout', 'task A')).toBe('sent')
    expect(readJournal(storeDir, 'scout').map((t) => t.text)).toEqual(['task A'])
    await until(() => readJournal(storeDir, 'scout')[0]?.state === 'running')
    release()
    await until(() => readJournal(storeDir, 'scout').length === 0)
  })

  it('after a crash mid-turn the next start replays it WITH the interruption note, queued ones as-is', async () => {
    registerRuntime(runtime(() => new Promise(() => { /* never returns: the "crash" happens first */ })))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'task A')
    await sendToHeadlessAgent('scout', 'task B')
    await until(() => readJournal(storeDir, 'scout')[0]?.state === 'running')
    // Crash: the in-memory loop is gone, the journal stays.
    const seen: string[] = []
    resetRuntimeRegistry()
    registerRuntime(runtime(async (prompt) => { seen.push(prompt); return { text: 'ok', blocked: false, sessionRef: 's' } }))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    await until(() => seen.length === 2)
    expect(seen[0].startsWith(INTERRUPTED_NOTE)).toBe(true)
    expect(seen[0]).toContain('task A')
    expect(seen[1]).toBe('task B')
    await until(() => readJournal(storeDir, 'scout').length === 0)
  })

  it('a fresh start drops the journal', async () => {
    mkdirSync(join(storeDir, 'headless-agents'), { recursive: true })
    writeFileSync(join(storeDir, 'headless-agents', 'scout.queue.json'), JSON.stringify([{ id: '1', text: 'old', enqueuedAt: 0, state: 'queued', attempts: 0 }]))
    const seen: string[] = []
    registerRuntime(runtime(async (p) => { seen.push(p); return { text: 'ok', blocked: false } }))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir })
    await startHeadlessAgent('scout', { fresh: true })
    await wait(50)
    expect(seen).toEqual([])
    expect(readJournal(storeDir, 'scout')).toEqual([])
  })

  it('an auth block defers the turn (kept for the next start) instead of dropping it', async () => {
    registerRuntime(runtime(async () => ({ text: null, blocked: true, reason: 'auth: not signed in (exit=3)' })))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir, notifyMain: () => {} })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'task A')
    await until(() => readJournal(storeDir, 'scout')[0]?.state === 'deferred')
    expect(headlessInfo('scout')?.state).toBe('auth')
  })
})

describe('stop, readiness, back-pressure', () => {
  it('stop aborts the in-flight run through the signal', async () => {
    let aborted = false
    registerRuntime(runtime((_p, opts) => new Promise((r) => { opts.signal?.addEventListener('abort', () => { aborted = true; r({ text: null, blocked: true, reason: 'aborted' }) }) })))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'long task')
    await until(() => headlessInfo('scout')?.state === 'busy')
    await stopHeadlessAgent('scout')
    await until(() => aborted)
    // The interrupted turn stays journalled for the next start.
    expect(readJournal(storeDir, 'scout')[0]?.state).toBe('running')
  })

  it('readiness counts queued turns, and the queue is bounded', async () => {
    registerRuntime(runtime(() => new Promise(() => {})))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    expect(headlessReady('scout')).toBe(true)
    await sendToHeadlessAgent('scout', 't0')
    expect(headlessReady('scout')).toBe(false) // queued, not yet busy: used to read as ready
    for (let i = 1; i <= MAX_QUEUED_TURNS; i++) await sendToHeadlessAgent('scout', `t${i}`)
    expect(await sendToHeadlessAgent('scout', 'one too many')).toBe('aborted-busy')
  })
})

describe('turn log', () => {
  it('is secret-scrubbed and rotates past the size limit', async () => {
    registerRuntime(runtime(async () => ({ text: 'token: sk-abcdefghijklmnopqrstuvwx returned', blocked: false })))
    _setHeadlessDepsForTest({ buildSpec: spec, storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'api_key=supersecretvalue123 please')
    await until(() => readHeadlessTurnLog('scout', 10, storeDir).some((l) => l.dir === 'out'))
    const raw = readFileSync(join(storeDir, 'headless-agents', 'scout.jsonl'), 'utf-8')
    expect(raw).not.toContain('supersecretvalue123')
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    // Rotation: an oversized log is moved aside on the next append.
    writeFileSync(join(storeDir, 'headless-agents', 'scout.jsonl'), 'x'.repeat(LOG_ROTATE_BYTES + 10) + '\n')
    await sendToHeadlessAgent('scout', 'next')
    await until(() => existsSync(join(storeDir, 'headless-agents', 'scout.jsonl.1')))
  })
})
