import { describe, it, expect } from 'vitest'
import { resolveProviderEnv, isAnthropicCompatProvider } from '../runtime/anthropic-compat-env.js'
import { resolveProviderEnv as viaAgentProcess, shSingleQuote } from '../web/agent-process.js'

describe('anthropic-compat-env (moved from agent-process.ts in Phase 0)', () => {
  it('agent-process.ts re-exports the SAME functions (no drift between the two names)', () => {
    expect(viaAgentProcess).toBe(resolveProviderEnv)
    expect(shSingleQuote("a'b")).toBe("'a'\\''b'")
  })

  it('kimi-* routes to the Moonshot Anthropic-compatible endpoint', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('kimi-k3', (id) => { seen.push(id); return 'ms-secret' })
    expect(r.provider).toBe('moonshot')
    expect(seen).toEqual(['MOONSHOT_API_KEY'])
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic')
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN="ms-secret"')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='kimi-k3'`)
  })

  it('glm-* routes to the Zhipu (z.ai) Anthropic-compatible endpoint', () => {
    const r = resolveProviderEnv('glm-5.3', () => 'z-secret')
    expect(r.provider).toBe('zhipu')
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic')
  })

  it('falls through the alias chain: canonical id found when the legacy id is absent', () => {
    const r = resolveProviderEnv('deepseek-v4-pro', (id) => (id === 'provider:deepseek:api-key' ? 'canon' : null))
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN="canon"')
  })

  it('openai / google have NO Anthropic-compatible endpoint: empty chain, provider "unsupported"', () => {
    let called = false
    const r1 = resolveProviderEnv('gpt-5.6-sol', () => { called = true; return 'x' })
    const r2 = resolveProviderEnv('gemini-2.5-pro', () => { called = true; return 'x' })
    expect(r1).toEqual({ provider: 'unsupported', exportsStr: '' })
    expect(r2).toEqual({ provider: 'unsupported', exportsStr: '' })
    expect(called).toBe(false)
  })

  it('isAnthropicCompatProvider', () => {
    expect(isAnthropicCompatProvider('deepseek')).toBe(true)
    expect(isAnthropicCompatProvider('ollama')).toBe(true)
    expect(isAnthropicCompatProvider('openai')).toBe(false)
    expect(isAnthropicCompatProvider('google')).toBe(false)
  })
})
