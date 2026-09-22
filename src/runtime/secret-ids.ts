// Vault id naming for provider credentials (Phase 0).
//
// New canonical scheme:   provider:<provider>:api-key   and   agent:<id>:api-key
// Legacy ids still in live vaults: DEEPSEEK_API_KEY, MINIMAX_API_KEY,
// openrouter-fleet-key, agent-<name>-api-key, OPENAI_API_KEY, GEMINI_API_KEY.
//
// Legacy ids come FIRST in every alias list, deliberately: an existing vault
// needs no migration, and the pre-Phase-0 tests that assert exactly which id
// was asked for keep passing (the lookup stops at the first hit).

import type { ProviderKind } from './types.js'

export function canonicalProviderSecretId(provider: ProviderKind): string {
  return `provider:${provider}:api-key`
}

export function canonicalAgentSecretId(agentId: string): string {
  return `agent:${agentId}:api-key`
}

const LEGACY_PROVIDER_IDS: Record<ProviderKind, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  openrouter: ['openrouter-fleet-key', 'OPENROUTER_API_KEY'],
  ollama: [],
  moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  zhipu: ['ZHIPU_API_KEY', 'ZAI_API_KEY'],
}

/** All vault ids that may hold this provider's key, in lookup order. */
export function providerSecretIds(provider: ProviderKind): readonly string[] {
  return [...LEGACY_PROVIDER_IDS[provider], canonicalProviderSecretId(provider)]
}

/** All vault ids that may hold a per-agent key override, in lookup order. */
export function agentSecretIds(agentId: string): readonly string[] {
  return [`agent-${agentId}-api-key`, canonicalAgentSecretId(agentId)]
}

/**
 * Resolve the API key for (provider, agent): a per-agent override wins over
 * the fleet-wide provider key. `getSecret` is injected so this stays pure.
 */
export function lookupProviderSecret(
  provider: ProviderKind,
  agentId: string | null,
  getSecret: (id: string) => string | null,
): { value: string; id: string } | null {
  const ids = [...(agentId ? agentSecretIds(agentId) : []), ...providerSecretIds(provider)]
  for (const id of ids) {
    const v = getSecret(id)
    if (v) return { value: v, id }
  }
  return null
}

/**
 * Environment variable each runtime expects the key in. Codex documents
 * CODEX_API_KEY for non-interactive runs; Gemini CLI reads GEMINI_API_KEY;
 * the Claude CLI reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN for the
 * Anthropic-compatible vendors, handled in anthropic-compat-env.ts).
 */
export const PROVIDER_ENV_VAR: Record<ProviderKind, string | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: null,
  moonshot: 'MOONSHOT_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
}
