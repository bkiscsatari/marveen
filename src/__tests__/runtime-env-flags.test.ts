// The runtime flags must work the way .env.example documents them: set in the
// install's .env, read by a dashboard whose systemd unit does NOT load .env.
import { describe, it, expect } from 'vitest'
import { flagEnv, RUNTIME_FLAG_KEYS } from '../runtime/env-flags.js'
import { workerRuntimeKind, bgRuntimeKind, agentBackend, envDefaultRuntime } from '../runtime/flags.js'
import { channelBridgeMode } from '../channel/service.js'
import { resolveRuntimeSpec } from '../runtime/resolve-spec.js'

describe('flagEnv: .env fills what process.env lacks', () => {
  it('reads every runtime flag from the file when the process has none', () => {
    const file = {
      MARVEEN_WORKER_RUNTIME: 'claude-headless',
      MARVEEN_BG_RUNTIME: 'minimax-cli',
      MARVEEN_DEFAULT_RUNTIME: 'claude-headless',
      MARVEEN_AGENT_BACKEND: 'sdk',
      CHANNEL_BRIDGE: 'marveen',
    }
    const env = flagEnv({ base: {}, readFile: () => file })
    for (const k of RUNTIME_FLAG_KEYS) expect(env[k]).toBe(file[k])
    expect(workerRuntimeKind(env)).toBe('claude-headless')
    expect(bgRuntimeKind(env)).toBe('minimax-cli')
    expect(agentBackend(env)).toBe('sdk')
    expect(envDefaultRuntime(env)).toBe('claude-headless')
    expect(channelBridgeMode(env)).toBe('marveen')
  })

  it('a non-empty process value wins; an empty one does not mask the file', () => {
    const env = flagEnv({
      base: { MARVEEN_BG_RUNTIME: 'claude-headless', CHANNEL_BRIDGE: '  ' },
      readFile: () => ({ MARVEEN_BG_RUNTIME: 'minimax-cli', CHANNEL_BRIDGE: 'marveen' }),
    })
    expect(env.MARVEEN_BG_RUNTIME).toBe('claude-headless')
    expect(env.CHANNEL_BRIDGE).toBe('marveen')
  })

  it('an unreadable file means defaults, never a throw', () => {
    const env = flagEnv({ base: {}, readFile: () => { throw new Error('EACCES') } })
    expect(bgRuntimeKind(env)).toBe('legacy-tmux')
    expect(channelBridgeMode(env)).toBe('plugin')
  })

  it('parsing is uniform: trimmed and case-insensitive for every flag', () => {
    expect(bgRuntimeKind({ MARVEEN_BG_RUNTIME: ' Claude-Headless ' })).toBe('claude-headless')
    expect(workerRuntimeKind({ MARVEEN_WORKER_RUNTIME: 'CLAUDE-HEADLESS' })).toBe('claude-headless')
    expect(bgRuntimeKind({ MARVEEN_BG_RUNTIME: 'typo' })).toBe('legacy-tmux')
  })
})

describe('MARVEEN_DEFAULT_RUNTIME cannot move an agent onto a runtime that cannot serve it', () => {
  it('a Claude agent ignores a codex-cli fleet default, with a warning', () => {
    const r = resolveRuntimeSpec('claude-sonnet-5', {}, { role: 'sub', envDefaultRuntime: 'codex-cli' })
    expect(r.runtime).toBe('claude-tmux')
    expect(r.source.runtime).toBe('default')
    expect(r.warnings.some((w) => w.startsWith('env_default_runtime_incompatible'))).toBe(true)
  })

  it('a compatible fleet default still applies', () => {
    const r = resolveRuntimeSpec('claude-sonnet-5', {}, { role: 'sub', envDefaultRuntime: ' Claude-Headless ' })
    expect(r.runtime).toBe('claude-headless')
    expect(r.source.runtime).toBe('env')
  })
})
