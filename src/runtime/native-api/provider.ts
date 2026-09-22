// LanguageModel factory for the native-api runtime (Phase 4), on Vercel AI
// SDK v7 (ai@7, provider packages 4.x/3.x, verified 2026-09-22).
//
// One provider-agnostic call site: generateText({ model: modelFor(spec) }).
// Vendors without an official AI SDK package go through their documented
// compatible surfaces:
//   MiniMax   -> Anthropic protocol  https://api.minimax.io/anthropic/v1
//   Moonshot  -> OpenAI protocol     https://api.moonshot.ai/v1
//   Zhipu     -> OpenAI protocol     https://api.z.ai/api/paas/v4
//   Ollama    -> ollama-ai-provider-v2 against $OLLAMA_URL/api
// Keys come from the vault through secret-ids.ts (per-agent override first).

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createOllama } from 'ollama-ai-provider-v2'
import type { LanguageModel } from 'ai'
import { OLLAMA_URL } from '../../config.js'
import { lookupProviderSecret, providerSecretIds, agentSecretIds } from '../secret-ids.js'
import type { ProviderKind } from '../types.js'

export interface ModelFactoryInputs {
  agentId: string
  provider: ProviderKind
  model: string
  secretLookup: (id: string) => string | null
  /** Override endpoints (tests, self-hosted gateways). */
  baseUrls?: Partial<Record<ProviderKind, string>>
  ollamaUrl?: string
}

export class MissingApiKeyError extends Error {
  constructor(public readonly provider: ProviderKind, ids: readonly string[]) {
    super(`No API key in the vault for provider "${provider}" (looked for: ${ids.join(', ')})`)
    this.name = 'MissingApiKeyError'
  }
}

function keyOrThrow(i: ModelFactoryInputs): string {
  const hit = lookupProviderSecret(i.provider, i.agentId, i.secretLookup)
  if (!hit) {
    // The id list goes into the message; values never do.
    throw new MissingApiKeyError(i.provider, [...agentSecretIds(i.agentId), ...providerSecretIds(i.provider)])
  }
  return hit.value
}

/** Strip the operator-only `[1m]` suffix before handing the id to a vendor SDK. */
export function vendorModelId(model: string): string {
  return model.replace(/\[1m\]$/i, '')
}

export function modelFor(i: ModelFactoryInputs): LanguageModel {
  const id = vendorModelId(i.model)
  const base = i.baseUrls ?? {}
  switch (i.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: keyOrThrow(i), ...(base.anthropic ? { baseURL: base.anthropic } : {}) })(id)
    case 'openai':
      return createOpenAI({ apiKey: keyOrThrow(i), ...(base.openai ? { baseURL: base.openai } : {}) })(id)
    case 'google':
      return createGoogleGenerativeAI({ apiKey: keyOrThrow(i), ...(base.google ? { baseURL: base.google } : {}) })(id)
    case 'deepseek':
      return createDeepSeek({ apiKey: keyOrThrow(i), ...(base.deepseek ? { baseURL: base.deepseek } : {}) })(id)
    case 'minimax':
      // MiniMax speaks the Anthropic protocol; the AI SDK provider posts to `${baseURL}/messages`.
      return createAnthropic({ apiKey: keyOrThrow(i), baseURL: base.minimax ?? 'https://api.minimax.io/anthropic/v1' })(id)
    case 'moonshot':
      return createOpenAICompatible({ name: 'moonshot', apiKey: keyOrThrow(i), baseURL: base.moonshot ?? 'https://api.moonshot.ai/v1' })(id)
    case 'zhipu':
      return createOpenAICompatible({ name: 'zhipu', apiKey: keyOrThrow(i), baseURL: base.zhipu ?? 'https://api.z.ai/api/paas/v4' })(id)
    case 'openrouter':
      return createOpenRouter({ apiKey: keyOrThrow(i), ...(base.openrouter ? { baseURL: base.openrouter } : {}) })(id)
    case 'ollama':
      return createOllama({ baseURL: `${(i.ollamaUrl ?? OLLAMA_URL).replace(/\/$/, '')}/api` })(id)
  }
}

/** Providers that need no key at all (local). */
export function providerNeedsKey(p: ProviderKind): boolean {
  return p !== 'ollama'
}
