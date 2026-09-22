import { describe, it, expect } from 'vitest'
import { contextWindowFor, findModel, providerFor, runtimesFor, baseModelId } from '../runtime/model-catalog.js'
import { contextLimitForModel } from '../context-guard.js'

describe('model catalog', () => {
  it('knows the verified Anthropic windows', () => {
    expect(contextWindowFor('claude-fable-5-1')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-5')).toBe(200_000)
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000)
  })

  it('[1m] suffix always wins, and is stripped for matching', () => {
    expect(baseModelId('claude-opus-4-8[1m]')).toBe('claude-opus-4-8')
    expect(contextWindowFor('claude-sonnet-5[1m]')).toBe(1_000_000)
    expect(findModel('claude-opus-4-8[1m]')?.id).toBe('claude-opus-4-8')
  })

  it('returns null for an unlisted model (the guard falls back to its own heuristic)', () => {
    expect(contextWindowFor('gpt-5.6-sol')).toBeNull()
    expect(contextWindowFor('qwen3.6:27b')).toBeNull()
    expect(contextWindowFor(null)).toBeNull()
  })

  it('non-Anthropic entries', () => {
    expect(contextWindowFor('gemini-2.5-pro')).toBe(1_048_576)
    expect(contextWindowFor('minimax-m3')).toBe(1_000_000)
    expect(contextWindowFor('deepseek-v4-pro')).toBe(200_000)
  })

  it('providerFor uses the catalog then the heuristic', () => {
    expect(providerFor('gemini-2.5-flash')).toBe('google')
    expect(providerFor('some/openrouter-id')).toBe('openrouter')
  })

  it('runtimesFor derives from the provider table', () => {
    expect(runtimesFor('gpt-5.6-sol')).toEqual(['codex-cli', 'native-api'])
    expect(runtimesFor('claude-sonnet-5')).toEqual(['claude-tmux', 'claude-headless', 'native-api'])
  })
})

describe('contextLimitForModel consults the catalog first, keeps its heuristics as fallback', () => {
  it('catalog hit: gemini 1,048,576 (previously the blanket 200k guess)', () => {
    expect(contextLimitForModel('gemini-2.5-pro')).toBe(1_048_576)
  })
  it('heuristic fallback for bare family names still works', () => {
    expect(contextLimitForModel('fable-5')).toBe(1_000_000)
    expect(contextLimitForModel('unknown-model')).toBe(200_000)
  })
})
