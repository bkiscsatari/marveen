// Headless session agents (src/web/headless-agents.ts): the loop that lets a
// fleet sub-agent live on a non-tmux runtime. Driven entirely through the
// dependency seams (no agents/ directory, no real CLI, no db): a fake runtime
// registered under a real kind records what run() was asked to do.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRuntime, resetRuntimeRegistry } from '../runtime/registry.js'
import type { AgentRuntime, AgentSpec, RunOptions, RunResult } from '../runtime/types.js'
import {
  _setHeadlessDepsForTest,
  headlessActivity,
  headlessInfo,
  headlessPaneState,
  headlessRunning,
  headlessRunningSince,
  headlessRuntimeFor,
  headlessState,
  readHeadlessTurnLog,
  sendToHeadlessAgent,
  startHeadlessAgent,
  stopHeadlessAgent,
} from '../web/headless-agents.js'

interface Call { prompt: string; resume: string | undefined; runtime: string; model: string }

function fakeRuntime(kind: AgentRuntime['kind'], calls: Call[], reply: (prompt: string) => RunResult | Promise<RunResult>): AgentRuntime {
  return {
    kind,
    capabilities: () => ({ interactive: false, supportsResume: true, supportsHooks: 'native', supportsMcp: true, supportsChannelsPlugin: false, reportsUsage: 'events', contextWindow: 1 }),
    spawn: async () => { throw new Error('not used') },
    send: async () => { throw new Error('not used') },
    run: async (agent: AgentSpec, prompt: string, opts: RunOptions = {}) => {
      calls.push({ prompt, resume: opts.resume, runtime: agent.runtime, model: agent.model })
      return reply(prompt)
    },
    state: async () => 'idle',
    stop: async () => {},
    usageSince: async () => ({ records: [], cursor: { value: 0 } }),
    healthProbe: async () => ({ ok: true, detail: 'fake' }),
  }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'scout', dir: '/tmp/scout', role: 'sub', model: 'minimax-m3', runtime: 'minimax-cli', provider: 'minimax',
    authMode: 'subscription', securityProfile: 'researcher', displayName: 'Scout', ...over,
  }
}

async function settle(name: string, turns: number, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const i = headlessInfo(name)
    if (i && i.state !== 'busy' && i.turns >= turns && i.queued === 0) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`agent ${name} did not settle after ${turns} turn(s)`)
}

let storeDir: string
let calls: Call[]
let notices: string[]

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'headless-'))
  calls = []
  notices = []
  resetRuntimeRegistry()
})

afterEach(() => {
  _setHeadlessDepsForTest(null)
  resetRuntimeRegistry()
  rmSync(storeDir, { recursive: true, force: true })
})

describe('headless session agent: lifecycle', () => {
  it('start -> running/idle, persisted; stop -> not running', async () => {
    registerRuntime(fakeRuntime('minimax-cli', calls, () => ({ text: 'ok', blocked: false, sessionRef: 's1' })))
    _setHeadlessDepsForTest({ buildSpec: () => spec(), storeDir: () => storeDir, now: () => 1_700_000_000_000 })
    expect(headlessRunning('scout')).toBe(false)
    const r = await startHeadlessAgent('scout')
    expect(r).toEqual({ ok: true })
    expect(headlessRunning('scout')).toBe(true)
    expect(headlessState('scout')).toBe('idle')
    expect(headlessPaneState('scout')).toBe('idle')
    expect(headlessRunningSince('scout')).toBe(1_700_000_000)
    expect(headlessInfo('scout')).toMatchObject({ runtime: 'minimax-cli', model: 'minimax-m3', routed: false, turns: 0, hooks: 'native' })
    const persisted = JSON.parse(readFileSync(join(storeDir, 'headless-agents.json'), 'utf-8'))
    expect(persisted.agents.scout).toMatchObject({ runtime: 'minimax-cli', model: 'minimax-m3', resumeToken: null })
    expect(await startHeadlessAgent('scout')).toEqual({ ok: false, error: 'Agent is already running' })
    expect(await stopHeadlessAgent('scout')).toEqual({ ok: true })
    expect(headlessRunning('scout')).toBe(false)
    expect(await stopHeadlessAgent('scout')).toEqual({ ok: false, error: 'Agent is not running' })
  })

  it('refuses a runtime this build cannot provide', async () => {
    _setHeadlessDepsForTest({ buildSpec: () => spec({ runtime: 'nope' as AgentSpec['runtime'] }), storeDir: () => storeDir })
    const r = await startHeadlessAgent('scout')
    expect(r.ok).toBe(false)
    expect(headlessRunning('scout')).toBe(false)
  })

  it('a claude-tmux spec is run as claude-headless (never a pane)', () => {
    expect(headlessRuntimeFor('claude-tmux')).toBe('claude-headless')
    expect(headlessRuntimeFor('minimax-cli')).toBe('minimax-cli')
  })
})

describe('headless session agent: turns', () => {
  it('one queued turn per send; the resume token threads the session through and survives a restart', async () => {
    let n = 0
    registerRuntime(fakeRuntime('minimax-cli', calls, () => ({ text: `reply ${++n}`, blocked: false, sessionRef: `sess-${n}` })))
    _setHeadlessDepsForTest({ buildSpec: () => spec(), storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    expect(await sendToHeadlessAgent('scout', 'first task')).toBe('sent')
    expect(await sendToHeadlessAgent('scout', 'second task')).toBe('sent')
    await settle('scout', 2)
    expect(calls.map((c) => [c.prompt, c.resume])).toEqual([['first task', undefined], ['second task', 'sess-1']])
    expect(headlessInfo('scout')).toMatchObject({ turns: 2, state: 'idle', lastError: null })
    const log = readHeadlessTurnLog('scout', 10, storeDir)
    expect(log.map((l) => l.dir)).toEqual(['in', 'out', 'in', 'out'])
    expect(log[3].text).toBe('reply 2')
    // A dashboard restart = stop + non-fresh start: the token on disk resumes.
    await stopHeadlessAgent('scout')
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'third task')
    await settle('scout', 1)
    expect(calls[2]).toMatchObject({ prompt: 'third task', resume: 'sess-2' })
    // A fresh start drops it.
    await stopHeadlessAgent('scout')
    await startHeadlessAgent('scout', { fresh: true })
    await sendToHeadlessAgent('scout', 'fourth task')
    await settle('scout', 1)
    expect(calls[3]).toMatchObject({ prompt: 'fourth task', resume: undefined })
  })

  it('a token is only reused on the same runtime+model', async () => {
    registerRuntime(fakeRuntime('minimax-cli', calls, () => ({ text: 'x', blocked: false, sessionRef: 'tok' })))
    registerRuntime(fakeRuntime('claude-headless', calls, () => ({ text: 'y', blocked: false, sessionRef: 'other' })))
    let current = spec()
    _setHeadlessDepsForTest({ buildSpec: () => current, storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'a'); await settle('scout', 1)
    await stopHeadlessAgent('scout')
    current = spec({ runtime: 'claude-headless', provider: 'anthropic', model: 'claude-sonnet-5' })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'b'); await settle('scout', 1)
    expect(calls[1]).toMatchObject({ runtime: 'claude-headless', resume: undefined })
  })

  it('is busy while a turn runs; abort-on-busy sends are refused, plain sends queue', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    registerRuntime(fakeRuntime('minimax-cli', calls, async () => { await gate; return { text: 'done', blocked: false } }))
    _setHeadlessDepsForTest({ buildSpec: () => spec(), storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'slow')
    await new Promise((r) => setTimeout(r, 10))
    expect(headlessState('scout')).toBe('busy')
    expect(headlessPaneState('scout')).toBe('busy')
    expect(headlessActivity('scout').state).toBe('working')
    expect(await sendToHeadlessAgent('scout', 'nudge', { onBusyTimeout: 'abort' })).toBe('aborted-busy')
    expect(await sendToHeadlessAgent('scout', 'queued')).toBe('sent')
    expect(headlessInfo('scout')?.queued).toBe(1)
    release()
    await settle('scout', 2)
    expect(calls.map((c) => c.prompt)).toEqual(['slow', 'queued'])
  })

  it('auth / limit failures set the state, alert the main agent once, and clear on the next good turn', async () => {
    const replies: RunResult[] = [
      { text: null, blocked: true, reason: 'exit=3 Sign in to MiniMax' },
      { text: null, blocked: true, reason: 'exit=3 Sign in to MiniMax' },
      { text: 'back', blocked: false },
      { text: null, blocked: true, reason: '429 rate limit' },
    ]
    registerRuntime(fakeRuntime('minimax-cli', calls, () => replies.shift()!))
    _setHeadlessDepsForTest({ buildSpec: () => spec(), storeDir: () => storeDir, notifyMain: (t) => { notices.push(t) } })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 't1'); await settle('scout', 1)
    expect(headlessState('scout')).toBe('auth')
    expect(headlessActivity('scout').state).toBe('auth')
    await sendToHeadlessAgent('scout', 't2'); await settle('scout', 2)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/scout .*minimax-cli\/minimax-m3.*hiteles/)
    await sendToHeadlessAgent('scout', 't3'); await settle('scout', 3)
    expect(headlessState('scout')).toBe('idle')
    await sendToHeadlessAgent('scout', 't4'); await settle('scout', 4)
    expect(headlessState('scout')).toBe('blocked')
    expect(notices).toHaveLength(2)
    expect(readHeadlessTurnLog('scout', 10, storeDir).filter((l) => l.dir === 'error')).toHaveLength(3)
  })

  it('a throwing runtime never wedges the loop', async () => {
    let first = true
    registerRuntime(fakeRuntime('minimax-cli', calls, () => { if (first) { first = false; throw new Error('boom') } return { text: 'fine', blocked: false } }))
    _setHeadlessDepsForTest({ buildSpec: () => spec(), storeDir: () => storeDir })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'a')
    await sendToHeadlessAgent('scout', 'b')
    await settle('scout', 1)
    expect(headlessInfo('scout')).toMatchObject({ turns: 1, state: 'idle' })
    expect(readHeadlessTurnLog('scout', 10, storeDir).some((l) => l.dir === 'error' && /boom/.test(l.text))).toBe(true)
  })
})

describe('headless session agent: Jev-routed', () => {
  it('starts on the routine_lowcost target (claude-tmux -> claude-headless) and switches on an applied decision', async () => {
    registerRuntime(fakeRuntime('claude-headless', calls, () => ({ text: 'cheap', blocked: false, sessionRef: 'c1' })))
    registerRuntime(fakeRuntime('minimax-cli', calls, () => ({ text: 'strong', blocked: false, sessionRef: 'm1' })))
    let routeCalls = 0
    _setHeadlessDepsForTest({
      buildSpec: () => spec({ runtime: 'claude-tmux', provider: 'anthropic', model: 'claude-fable-5' }),
      readRouting: () => 'jev',
      initialRoutedTarget: () => ({ ok: true, runtime: 'claude-tmux', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
      routingAll: () => true,
      routeForTurn: async (input) => {
        routeCalls++
        expect(input.currentProfile).toBe(routeCalls === 1 ? 'routine_lowcost' : 'build_strong')
        return routeCalls === 1
          ? { profile: 'build_strong', runtime: 'minimax-cli', provider: 'minimax', model: 'minimax-m3' }
          : null
      },
      storeDir: () => storeDir,
    })
    await startHeadlessAgent('scout')
    expect(headlessInfo('scout')).toMatchObject({ runtime: 'claude-headless', model: 'claude-haiku-4-5-20251001', routed: true, profile: 'routine_lowcost' })
    await sendToHeadlessAgent('scout', 'build the thing'); await settle('scout', 1)
    expect(calls[0]).toMatchObject({ runtime: 'minimax-cli', model: 'minimax-m3', resume: undefined })
    expect(headlessInfo('scout')).toMatchObject({ runtime: 'minimax-cli', model: 'minimax-m3', profile: 'build_strong' })
    await sendToHeadlessAgent('scout', 'and again'); await settle('scout', 2)
    expect(calls[1]).toMatchObject({ runtime: 'minimax-cli', resume: 'm1' })
    const log = readHeadlessTurnLog('scout', 10, storeDir)
    expect(log.map((l) => l.dir)).toEqual(['switch', 'in', 'out', 'in', 'out'])
    expect(log[0].text).toMatch(/claude-headless\/claude-haiku-4-5-20251001 -> minimax-cli\/minimax-m3 \(build_strong\)/)
  })

  it('does not ask the router unless MODEL_ROUTING=all', async () => {
    registerRuntime(fakeRuntime('claude-headless', calls, () => ({ text: 'cheap', blocked: false })))
    let asked = 0
    _setHeadlessDepsForTest({
      buildSpec: () => spec({ runtime: 'claude-tmux', provider: 'anthropic', model: 'claude-fable-5' }),
      readRouting: () => 'jev',
      initialRoutedTarget: () => ({ ok: true, runtime: 'claude-headless', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
      routingAll: () => false,
      routeForTurn: async () => { asked++; return { profile: 'build_strong', runtime: 'minimax-cli', provider: 'minimax', model: 'minimax-m3' } },
      storeDir: () => storeDir,
    })
    await startHeadlessAgent('scout')
    await sendToHeadlessAgent('scout', 'x'); await settle('scout', 1)
    expect(asked).toBe(0)
    expect(headlessInfo('scout')?.runtime).toBe('claude-headless')
  })

  it('a routed agent without a profile map cannot start', async () => {
    _setHeadlessDepsForTest({ buildSpec: () => spec(), readRouting: () => 'jev', storeDir: () => storeDir })
    const r = await startHeadlessAgent('scout')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/profile map/)
    expect(existsSync(join(storeDir, 'headless-agents.json'))).toBe(false)
  })
})
