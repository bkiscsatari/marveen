import { describe, it, expect } from 'vitest'
import { validateModelProfileMap, resolveProfileTarget } from '../model-profiles.js'
import { normalizeRoutingMode, pickTarget, type RoutingDecision } from '../model-router.js'
import { targetAvailability } from '../web/model-routing.js'

describe('profile map targets (Phase 4b)', () => {
  it('accepts legacy string values and {model, runtime, provider} objects side by side', () => {
    const st = validateModelProfileMap({
      profiles: {
        premium_reasoning: 'claude-opus-5[1m]',
        build_strong: { model: 'gpt-5.6-sol', runtime: 'codex-cli', provider: 'openai' },
        analysis_efficient: { model: 'deepseek-chat', runtime: 'native-api' },
        routine_lowcost: { model: 'qwen2.5:1.5b', runtime: 'native-api', provider: 'ollama' },
      },
    })
    expect(st.ok).toBe(true)
    if (!st.ok) return
    expect(st.map.profiles.build_strong).toBe('gpt-5.6-sol')
    expect(st.map.targets.build_strong).toEqual({ model: 'gpt-5.6-sol', runtime: 'codex-cli', provider: 'openai' })
    expect(st.map.targets.premium_reasoning).toEqual({ model: 'claude-opus-5[1m]' })
    expect(resolveProfileTarget('analysis_efficient', st, (m) => m)).toEqual({ model: 'deepseek-chat', runtime: 'native-api' })
  })
  it('rejects unknown runtime/provider names and empty models in object form', () => {
    const base = { premium_reasoning: 'a', build_strong: 'b', analysis_efficient: 'c' }
    expect(validateModelProfileMap({ profiles: { ...base, routine_lowcost: { model: 'x', runtime: 'nope' } } })).toMatchObject({ ok: false, error: 'profile_map_unknown_runtime:routine_lowcost:nope' })
    expect(validateModelProfileMap({ profiles: { ...base, routine_lowcost: { model: 'x', provider: 'acme' } } })).toMatchObject({ ok: false, error: 'profile_map_unknown_provider:routine_lowcost:acme' })
    expect(validateModelProfileMap({ profiles: { ...base, routine_lowcost: { model: ' ' } } })).toMatchObject({ ok: false, error: 'profile_map_missing_or_empty:routine_lowcost' })
  })
})

describe('routing modes (B1 real now)', () => {
  it('off | shadow | background; all -> background (respawn path not wired yet)', () => {
    expect(normalizeRoutingMode(undefined)).toBe('off')
    expect(normalizeRoutingMode('shadow')).toBe('shadow')
    expect(normalizeRoutingMode('background')).toBe('background')
    expect(normalizeRoutingMode('ALL ')).toBe('background')
    expect(normalizeRoutingMode('junk')).toBe('off')
  })
})

describe('pickTarget', () => {
  const targets = {
    premium_reasoning: { model: 'claude-opus-5', runtime: 'claude-headless' as const },
    build_strong: { model: 'gpt-5.6-sol', runtime: 'codex-cli' as const },
    analysis_efficient: { model: 'deepseek-chat', runtime: 'native-api' as const },
    routine_lowcost: { model: 'qwen2.5:1.5b', runtime: 'native-api' as const },
  }
  const ok: RoutingDecision = { profile: 'analysis_efficient', confidence: 0.9, needsReview: false, actionable: true, reasons: [] }
  it('applies an actionable, available suggestion', () => {
    expect(pickTarget(ok, targets, () => true)).toEqual({ kind: 'apply', profile: 'analysis_efficient', target: targets.analysis_efficient })
  })
  it('skips when not actionable / needs review / no map', () => {
    expect(pickTarget({ ...ok, actionable: false }, targets, () => true)).toMatchObject({ kind: 'skip', reason: 'not_actionable' })
    expect(pickTarget({ ...ok, profile: null, needsReview: true }, targets, () => true)).toMatchObject({ kind: 'skip', reason: 'needs_review' })
    expect(pickTarget(ok, { ...targets, analysis_efficient: null }, () => true)).toMatchObject({ kind: 'skip', reason: 'profile_map_missing:analysis_efficient' })
  })
  it('an unavailable target climbs to the next STRONGER available tier, never weaker', () => {
    const avail = (t: { model: string }) => t.model !== 'deepseek-chat' && t.model !== 'gpt-5.6-sol'
    const p = pickTarget(ok, targets, avail)
    expect(p).toMatchObject({ kind: 'apply', profile: 'premium_reasoning' })
    expect(pickTarget(ok, targets, () => false)).toMatchObject({ kind: 'skip', reason: expect.stringMatching(/^target_unavailable/) })
  })
})

describe('targetAvailability', () => {
  const base = { availableRuntimes: ['claude-tmux', 'claude-headless', 'codex-cli', 'gemini-cli', 'native-api'] as const, secretLookup: () => null, fleetOauthToken: null, agentId: 'a' }
  it('ollama needs nothing; anthropic on a claude runtime needs the fleet token; api vendors need a vault key', () => {
    expect(targetAvailability({ model: 'qwen2.5:1.5b', runtime: 'native-api' }, { ...base, availableRuntimes: [...base.availableRuntimes] })).toMatchObject({ available: true, provider: 'ollama' })
    expect(targetAvailability({ model: 'claude-sonnet-5', runtime: 'claude-headless' }, { ...base, availableRuntimes: [...base.availableRuntimes] })).toMatchObject({ available: false, reason: 'no_api_key:anthropic' })
    expect(targetAvailability({ model: 'claude-sonnet-5', runtime: 'claude-headless' }, { ...base, availableRuntimes: [...base.availableRuntimes], fleetOauthToken: 't' }).available).toBe(true)
    expect(targetAvailability({ model: 'deepseek-chat' }, { ...base, availableRuntimes: [...base.availableRuntimes], secretLookup: (id) => (id === 'DEEPSEEK_API_KEY' ? 'k' : null) })).toMatchObject({ available: true, runtime: 'claude-tmux', provider: 'deepseek' })
  })
  it('an unshipped runtime or a mismatched pair is unavailable', () => {
    expect(targetAvailability({ model: 'gpt-5.6-sol', runtime: 'codex-cli' }, { ...base, availableRuntimes: ['claude-tmux'] })).toMatchObject({ available: false, reason: 'runtime_unavailable:codex-cli' })
    expect(targetAvailability({ model: 'gpt-5.6-sol', runtime: 'claude-headless' }, { ...base, availableRuntimes: [...base.availableRuntimes] })).toMatchObject({ available: false, reason: 'runtime_provider_mismatch:claude-headless/openai' })
  })
})
