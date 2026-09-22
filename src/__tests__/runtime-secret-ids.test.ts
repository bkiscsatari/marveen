import { describe, it, expect } from 'vitest'
import {
  providerSecretIds,
  agentSecretIds,
  lookupProviderSecret,
  canonicalProviderSecretId,
  canonicalAgentSecretId,
} from '../runtime/secret-ids.js'

describe('secret id aliases', () => {
  it('legacy ids come FIRST so existing vaults need no migration', () => {
    expect(providerSecretIds('deepseek')).toEqual(['DEEPSEEK_API_KEY', 'provider:deepseek:api-key'])
    expect(providerSecretIds('openrouter')[0]).toBe('openrouter-fleet-key')
    expect(providerSecretIds('minimax')[0]).toBe('MINIMAX_API_KEY')
    expect(agentSecretIds('argus')).toEqual(['agent-argus-api-key', 'agent:argus:api-key'])
  })

  it('every provider list ends with the canonical id', () => {
    for (const p of ['anthropic', 'openai', 'google', 'deepseek', 'minimax', 'openrouter', 'ollama', 'moonshot', 'zhipu'] as const) {
      const ids = providerSecretIds(p)
      expect(ids[ids.length - 1]).toBe(canonicalProviderSecretId(p))
    }
    expect(canonicalAgentSecretId('brix')).toBe('agent:brix:api-key')
  })

  it('lookupProviderSecret: per-agent override beats the fleet key', () => {
    const vault: Record<string, string> = {
      'DEEPSEEK_API_KEY': 'fleet',
      'agent-scout-api-key': 'scout-own',
    }
    const get = (id: string) => vault[id] ?? null
    expect(lookupProviderSecret('deepseek', 'scout', get)).toEqual({ value: 'scout-own', id: 'agent-scout-api-key' })
    expect(lookupProviderSecret('deepseek', 'argus', get)).toEqual({ value: 'fleet', id: 'DEEPSEEK_API_KEY' })
    expect(lookupProviderSecret('deepseek', null, get)?.value).toBe('fleet')
  })

  it('lookupProviderSecret: canonical ids are found when legacy ones are absent', () => {
    const get = (id: string) => (id === 'provider:openai:api-key' ? 'k' : null)
    expect(lookupProviderSecret('openai', null, get)).toEqual({ value: 'k', id: 'provider:openai:api-key' })
  })

  it('returns null when nothing matches (ollama has no key at all)', () => {
    expect(lookupProviderSecret('ollama', 'x', () => null)).toBeNull()
  })
})
