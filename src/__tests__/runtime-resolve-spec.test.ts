import { describe, it, expect } from 'vitest'
import {
  inferProvider,
  normalizeAuthMode,
  defaultRuntimeFor,
  defaultAuthModeFor,
  runtimeSupportsProvider,
  resolveRuntimeSpec,
} from '../runtime/resolve-spec.js'

describe('inferProvider -- the single prefix heuristic', () => {
  it.each([
    ['claude-opus-5[1m]', 'anthropic'],
    ['claude-sonnet-5', 'anthropic'],
    ['deepseek-v4-pro', 'deepseek'],
    ['minimax-m3', 'minimax'],
    ['kimi-k3', 'moonshot'],
    ['moonshot-v1-128k', 'moonshot'],
    ['glm-5.3', 'zhipu'],
    ['gemini-2.5-pro', 'google'],
    ['gpt-5.6-sol', 'openai'],
    ['o3-pro', 'openai'],
    ['codex-mini-latest', 'openai'],
    ['chatgpt-4o-latest', 'openai'],
    ['minimax/minimax-m3', 'openrouter'],
    ['qwen/qwen3-coder', 'openrouter'],
    ['qwen3.6:27b', 'ollama'],
    ['llama3', 'ollama'],
  ] as const)('%s -> %s', (model, provider) => {
    expect(inferProvider(model)).toBe(provider)
  })

  it('is case-insensitive and trims', () => {
    expect(inferProvider('  Claude-Sonnet-5 ')).toBe('anthropic')
    expect(inferProvider('GPT-5')).toBe('openai')
  })

  it('does not mistake an ollama tag containing "o1" for openai', () => {
    expect(inferProvider('phi-o1:latest')).toBe('ollama')
    expect(inferProvider('o1x')).toBe('ollama')
  })
})

describe('normalizeAuthMode -- accepts the legacy Claude-only vocabulary', () => {
  it.each([
    ['api', 'api'],
    ['subscription', 'subscription'],
    ['shared', 'subscription'],
    ['own_team', 'subscription'],
    ['oauth', 'subscription'],
    ['API', 'api'],
  ] as const)('%s -> %s', (raw, expected) => {
    expect(normalizeAuthMode(raw)).toBe(expected)
  })
  it('rejects junk', () => {
    expect(normalizeAuthMode('free')).toBeNull()
    expect(normalizeAuthMode(42)).toBeNull()
    expect(normalizeAuthMode(undefined)).toBeNull()
  })
})

describe('defaultRuntimeFor -- Phase 0 is behaviour-neutral for everything the Claude CLI could reach', () => {
  it.each(['anthropic', 'deepseek', 'minimax', 'moonshot', 'zhipu', 'openrouter', 'ollama'] as const)(
    '%s stays on claude-tmux whatever the auth mode and role', (provider) => {
      expect(defaultRuntimeFor(provider, 'subscription', 'sub')).toBe('claude-tmux')
      expect(defaultRuntimeFor(provider, 'api', 'worker')).toBe('claude-tmux')
      expect(defaultRuntimeFor(provider, 'api', 'background')).toBe('claude-tmux')
    },
  )
  it('openai: subscription -> codex-cli, api -> native-api', () => {
    expect(defaultRuntimeFor('openai', 'subscription', 'sub')).toBe('codex-cli')
    expect(defaultRuntimeFor('openai', 'api', 'sub')).toBe('native-api')
  })
  it('google: subscription -> gemini-cli, api -> native-api', () => {
    expect(defaultRuntimeFor('google', 'subscription', 'main')).toBe('gemini-cli')
    expect(defaultRuntimeFor('google', 'api', 'main')).toBe('native-api')
  })
})

describe('defaultAuthModeFor', () => {
  it('subscription-first vendors', () => {
    expect(defaultAuthModeFor('anthropic')).toBe('subscription')
    expect(defaultAuthModeFor('openai')).toBe('subscription')
    expect(defaultAuthModeFor('google')).toBe('subscription')
  })
  it('api-only vendors', () => {
    expect(defaultAuthModeFor('deepseek')).toBe('api')
    expect(defaultAuthModeFor('ollama')).toBe('api')
  })
})

describe('runtimeSupportsProvider', () => {
  it('claude runtimes cannot serve openai/google (no Anthropic-compatible endpoint)', () => {
    expect(runtimeSupportsProvider('claude-tmux', 'openai')).toBe(false)
    expect(runtimeSupportsProvider('claude-headless', 'google')).toBe(false)
    expect(runtimeSupportsProvider('claude-tmux', 'deepseek')).toBe(true)
  })
  it('codex-cli / gemini-cli are single-vendor; native-api serves all', () => {
    expect(runtimeSupportsProvider('codex-cli', 'openai')).toBe(true)
    expect(runtimeSupportsProvider('codex-cli', 'anthropic')).toBe(false)
    expect(runtimeSupportsProvider('gemini-cli', 'google')).toBe(true)
    expect(runtimeSupportsProvider('native-api', 'minimax')).toBe(true)
  })
})

describe('resolveRuntimeSpec -- precedence and warnings', () => {
  it('a config with no runtime fields resolves exactly like before Phase 0', () => {
    const r = resolveRuntimeSpec('claude-fable-5-1', {}, { role: 'sub' })
    expect(r).toMatchObject({ runtime: 'claude-tmux', provider: 'anthropic', authMode: 'subscription' })
    expect(r.source).toEqual({ runtime: 'default', provider: 'inferred', authMode: 'default' })
    expect(r.warnings).toEqual([])
  })

  it('explicit config runtime wins over the env default', () => {
    const r = resolveRuntimeSpec('claude-sonnet-5', { runtime: 'claude-headless' }, { role: 'worker', envDefaultRuntime: 'claude-tmux' })
    expect(r.runtime).toBe('claude-headless')
    expect(r.source.runtime).toBe('config')
  })

  it('env default applies when config is silent', () => {
    const r = resolveRuntimeSpec('claude-sonnet-5', {}, { role: 'worker', envDefaultRuntime: 'claude-headless' })
    expect(r.runtime).toBe('claude-headless')
    expect(r.source.runtime).toBe('env')
  })

  it('an unknown runtime in config is ignored WITH a warning, never honoured', () => {
    const r = resolveRuntimeSpec('claude-sonnet-5', { runtime: 'bogus-cli' }, { role: 'sub' })
    expect(r.runtime).toBe('claude-tmux')
    expect(r.warnings.some((w) => w.startsWith('unknown_runtime:'))).toBe(true)
  })

  it('an unknown env default is ignored with a warning', () => {
    const r = resolveRuntimeSpec('claude-sonnet-5', {}, { role: 'sub', envDefaultRuntime: 'nope' })
    expect(r.runtime).toBe('claude-tmux')
    expect(r.warnings.some((w) => w.startsWith('unknown_env_default_runtime:'))).toBe(true)
  })

  it('legacy authMode values from agent-config.json normalise', () => {
    expect(resolveRuntimeSpec('claude-sonnet-5', { authMode: 'own_team' }, { role: 'sub' }).authMode).toBe('subscription')
    expect(resolveRuntimeSpec('claude-sonnet-5', { authMode: 'api' }, { role: 'sub' }).authMode).toBe('api')
  })

  it('openai subscription -> codex-cli; openai api -> native-api', () => {
    expect(resolveRuntimeSpec('gpt-5.6-sol', {}, { role: 'sub' }).runtime).toBe('codex-cli')
    expect(resolveRuntimeSpec('gpt-5.6-sol', { authMode: 'api' }, { role: 'sub' }).runtime).toBe('native-api')
  })

  it('warns when the runtime cannot serve the provider (claude-tmux + gpt)', () => {
    const r = resolveRuntimeSpec('gpt-5.6-sol', { runtime: 'claude-tmux' }, { role: 'sub' })
    expect(r.runtime).toBe('claude-tmux') // honoured -- explicit config
    expect(r.warnings.some((w) => w.startsWith('runtime_provider_mismatch'))).toBe(true)
  })

  it('warns when the configured provider disagrees with the model id', () => {
    const r = resolveRuntimeSpec('deepseek-v4-pro', { provider: 'openrouter' }, { role: 'sub' })
    expect(r.provider).toBe('openrouter')
    expect(r.source.provider).toBe('config')
    expect(r.warnings.some((w) => w.startsWith('provider_mismatch'))).toBe(true)
  })
})
