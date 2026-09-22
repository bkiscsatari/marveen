import { describe, it, expect, beforeEach } from 'vitest'
import {
  getRuntime,
  registerRuntime,
  resetRuntimeRegistry,
  listRegisteredRuntimes,
  availableRuntimeKinds,
  defaultRuntimeKind,
  RuntimeNotAvailableError,
} from '../runtime/registry.js'
import type { AgentRuntime } from '../runtime/types.js'

function fakeRuntime(kind: AgentRuntime['kind']): AgentRuntime {
  return {
    kind,
    capabilities: () => ({
      interactive: false, supportsResume: false, supportsHooks: 'none', supportsMcp: false,
      supportsChannelsPlugin: false, reportsUsage: 'none', contextWindow: 1,
    }),
    spawn: async (a) => ({ agentId: a.id, runtime: kind, sessionRef: 'x' }),
    send: async () => 'sent',
    run: async () => ({ text: 'ok', blocked: false }),
    state: async () => 'idle',
    stop: async () => {},
    usageSince: async () => ({ records: [], cursor: { value: null } }),
    healthProbe: async () => ({ ok: true, detail: 'fake' }),
  }
}

describe('runtime registry', () => {
  beforeEach(() => resetRuntimeRegistry())

  it('returns a registered adapter by kind', async () => {
    const rt = fakeRuntime('native-api')
    registerRuntime(rt)
    expect(await getRuntime('native-api')).toBe(rt)
    expect(listRegisteredRuntimes()).toEqual(['native-api'])
  })

  it('every adapter ships now; the phase-naming error stays for an unknown kind', async () => {
    await expect(getRuntime('bogus' as never)).rejects.toBeInstanceOf(RuntimeNotAvailableError)
    for (const k of ['claude-headless', 'codex-cli', 'gemini-cli', 'native-api', 'minimax-cli'] as const) expect((await getRuntime(k)).kind).toBe(k)
  })

  it('claude-tmux loads lazily on first request and is cached', async () => {
    expect(listRegisteredRuntimes()).toEqual([])
    const rt = await getRuntime('claude-tmux')
    expect(rt.kind).toBe('claude-tmux')
    expect(listRegisteredRuntimes()).toEqual(['claude-tmux'])
    expect(await getRuntime('claude-tmux')).toBe(rt)
  })

  it('availableRuntimeKinds = registered + loadable built-ins (Phase 0: tmux, Phase 1: headless)', () => {
    expect(availableRuntimeKinds()).toEqual(['claude-tmux', 'claude-headless', 'codex-cli', 'gemini-cli', 'native-api', 'minimax-cli'])
    registerRuntime(fakeRuntime('native-api'))
    expect(availableRuntimeKinds()).toEqual(['claude-tmux', 'claude-headless', 'codex-cli', 'gemini-cli', 'native-api', 'minimax-cli'])
  })

  it('claude-headless loads lazily too', async () => {
    const rt = await getRuntime('claude-headless')
    expect(rt.kind).toBe('claude-headless')
  })

  it('defaultRuntimeKind honours a VALID env override only', () => {
    expect(defaultRuntimeKind({})).toBe('claude-tmux')
    expect(defaultRuntimeKind({ MARVEEN_DEFAULT_RUNTIME: 'claude-headless' })).toBe('claude-headless')
    expect(defaultRuntimeKind({ MARVEEN_DEFAULT_RUNTIME: 'typo' })).toBe('claude-tmux')
    expect(defaultRuntimeKind({ MARVEEN_DEFAULT_RUNTIME: ' ' })).toBe('claude-tmux')
  })
})
