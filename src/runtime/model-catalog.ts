// Provider-aware model catalog (Phase 0).
//
// Replaces three scattered facts with one table: which vendor a model belongs
// to, how large its context window is, and which runtimes can execute it.
// Only entries with a VERIFIED context window are listed (Models API, vendor
// docs, or this host's own measured transcripts -- see the notes); unknown
// models fall back to the conservative heuristics in context-guard.ts, which
// self-calibrate upward from live evidence. Over-estimating a window blinds
// the context guard silently (2026-07-26 incident); under-estimating is loud
// and self-correcting, so absence here is the safe default.
//
// Pure data + lookups: no I/O, no env.

import { inferProvider } from './resolve-spec.js'
import { RUNTIME_PROVIDERS } from './resolve-spec.js'
import type { ProviderKind, RuntimeKind } from './types.js'

export type ModelTier = 'premium' | 'strong' | 'efficient' | 'lowcost'

export interface ModelCatalogEntry {
  /** Exact id, or a prefix when `prefix` is true. Matched case-insensitively. */
  id: string
  prefix?: boolean
  provider: ProviderKind
  contextWindow: number
  tier?: ModelTier
  note?: string
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  // --- Anthropic (windows verified on this host: fable/opus-5 sessions measured 911k-999k, sonnet max 197,885) ---
  { id: 'claude-fable-5', prefix: true, provider: 'anthropic', contextWindow: 1_000_000, tier: 'premium' },
  { id: 'claude-mythos-5', prefix: true, provider: 'anthropic', contextWindow: 1_000_000, tier: 'premium' },
  { id: 'claude-opus-5', prefix: true, provider: 'anthropic', contextWindow: 1_000_000, tier: 'premium' },
  { id: 'claude-opus-4-8', prefix: true, provider: 'anthropic', contextWindow: 1_000_000, tier: 'strong' },
  { id: 'claude-opus-4-6', prefix: true, provider: 'anthropic', contextWindow: 1_000_000, tier: 'strong' },
  { id: 'claude-sonnet-5', prefix: true, provider: 'anthropic', contextWindow: 200_000, tier: 'strong' },
  { id: 'claude-haiku-4-5', prefix: true, provider: 'anthropic', contextWindow: 200_000, tier: 'lowcost' },
  // --- MiniMax (1M with the CLAUDE_CODE_MAX_CONTEXT_TOKENS override; measured live 2026-08-19) ---
  { id: 'minimax-m3', prefix: true, provider: 'minimax', contextWindow: 1_000_000, tier: 'strong' },
  // --- DeepSeek (kept at 200k on live measurement; see context-guard.ts) ---
  { id: 'deepseek-v4-pro', prefix: true, provider: 'deepseek', contextWindow: 200_000, tier: 'strong' },
  { id: 'deepseek-flash', prefix: true, provider: 'deepseek', contextWindow: 200_000, tier: 'lowcost' },
  { id: 'deepseek-chat', provider: 'deepseek', contextWindow: 200_000, tier: 'efficient' },
  // --- Google (1,048,576 per the Gemini API model docs) ---
  { id: 'gemini-2.5-pro', prefix: true, provider: 'google', contextWindow: 1_048_576, tier: 'premium' },
  { id: 'gemini-2.5-flash', prefix: true, provider: 'google', contextWindow: 1_048_576, tier: 'efficient' },
]

function matches(entry: ModelCatalogEntry, model: string): boolean {
  const m = model.toLowerCase()
  const id = entry.id.toLowerCase()
  return entry.prefix ? m.startsWith(id) : m === id || m === `${id}[1m]`
}

/** Strip the operator's `[1m]` opt-in suffix for catalog matching. */
export function baseModelId(model: string): string {
  return model.replace(/\[1m\]$/i, '')
}

export function findModel(model: string): ModelCatalogEntry | null {
  const base = baseModelId(model.trim())
  for (const e of MODEL_CATALOG) {
    if (matches(e, base)) return e
  }
  return null
}

/**
 * Catalog context window, or null when the model is not listed. The `[1m]`
 * suffix always wins (explicit operator opt-in), matching the historical
 * contextLimitForModel contract.
 */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (typeof model !== 'string') return null
  if (model.toLowerCase().includes('[1m]')) return 1_000_000
  return findModel(model)?.contextWindow ?? null
}

/** Provider for a model: catalog first, prefix heuristic second. */
export function providerFor(model: string): ProviderKind {
  return findModel(model)?.provider ?? inferProvider(model)
}

/** Runtimes that can execute this model (derived from its provider). */
export function runtimesFor(model: string): readonly RuntimeKind[] {
  const provider = providerFor(model)
  return (Object.keys(RUNTIME_PROVIDERS) as RuntimeKind[]).filter((rt) =>
    RUNTIME_PROVIDERS[rt].includes(provider),
  )
}
