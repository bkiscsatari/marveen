// Minimal TypeSafe AI (Jev) HTTP client: one endpoint, one timeout, no SDK.
//
// POST https://api.typesafe.ai/v1/systemone with { model, state, questions }
// and a Bearer key; the answer is a plain JSON object. Node 22's global
// fetch is enough, and keeping the dependency list unchanged matters more
// than the SDK's conveniences for a shadow-only feature.
//
// Every failure returns null and is logged at warn. A routing suggestion is
// optional; a delivery must never wait on it or fail because of it.

import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
// Pinned: a silent model bump would invalidate every threshold fitted on the
// shadow log (docs/models.md: jev-1.13.0 behind jev-latest, 2026-09-21).
export const JEV_MODEL = 'jev-1.13.0'
export const JEV_PRICE_USD_PER_MTOK = 0.042
export const DEFAULT_TIMEOUT_MS = 1500

export interface JevResult {
  model: string
  answers: Record<string, unknown>
  inputTokens: number
  latencyMs: number
  costUsd: number
}

let cachedKey: { value: string | null; readAt: number } | null = null
const KEY_CACHE_MS = 60_000

export function readTypeSafeKey(): string | null {
  const fromProcess = (process.env.TYPESAFE_API_KEY ?? '').trim()
  if (fromProcess) return fromProcess
  const now = Date.now()
  if (cachedKey && now - cachedKey.readAt < KEY_CACHE_MS) return cachedKey.value
  let value: string | null = null
  try {
    value = (readEnvFile(['TYPESAFE_API_KEY'])['TYPESAFE_API_KEY'] ?? '').trim() || null
  } catch {
    value = null
  }
  cachedKey = { value, readAt: now }
  return value
}

export function jevConfigured(): boolean {
  return readTypeSafeKey() !== null
}

export async function jevSystemOne(
  state: unknown,
  questions: Record<string, unknown>,
  opts: { timeoutMs?: number; apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<JevResult | null> {
  const apiKey = opts.apiKey ?? readTypeSafeKey()
  if (!apiKey) return null
  const doFetch = opts.fetchImpl ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const res = await doFetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: ctrl.signal,
    })
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      logger.warn({ status: res.status, latencyMs }, 'jev: non-2xx response')
      return null
    }
    const body = (await res.json()) as { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number } }
    const inputTokens = Number(body.usage?.input_tokens ?? 0) || 0
    return {
      model: typeof body.model === 'string' ? body.model : JEV_MODEL,
      answers: body.answers ?? {},
      inputTokens,
      latencyMs,
      costUsd: (inputTokens * JEV_PRICE_USD_PER_MTOK) / 1_000_000,
    }
  } catch (err) {
    logger.warn({ err: String(err), latencyMs: Date.now() - t0 }, 'jev: request failed')
    return null
  } finally {
    clearTimeout(timer)
  }
}
