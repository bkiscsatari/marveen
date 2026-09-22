// Per-runtime quota/rate-limit cool-down, fed by run outcomes.
//
// The Jev resolver treated every configured target as having budget ("quota
// windows feed in here later"), so a routed task could be sent straight into a
// runtime that had just answered 429 / usage limit. Every CLI/native run now
// reports its outcome here (cli-process.recordUsageBestEffort); a rate-limit
// block marks the runtime+provider as cooling down, and targetAvailability()
// skips it -- pickTarget then climbs to the next STRONGER available tier, never
// a weaker one. In-memory on purpose: a restart forgets it, and the next run
// re-discovers a still-active limit within one call.

import type { RunResult } from './types.js'

export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000
const RATE_LIMIT_RX = /\b429\b|rate.?limit|usage limit|quota|RESOURCE_EXHAUSTED|insufficient[_ ]quota|overloaded/i

const until = new Map<string, number>()
const key = (runtime: string, provider: string) => `${runtime}/${provider}`

/** Pure: is this result a rate/quota block? */
export function isRateLimited(r: Pick<RunResult, 'blocked' | 'reason'>): boolean {
  return !!r.blocked && RATE_LIMIT_RX.test(r.reason ?? '')
}

export function noteRunOutcome(runtime: string, provider: string, r: Pick<RunResult, 'blocked' | 'reason'>, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS): void {
  if (isRateLimited(r)) until.set(key(runtime, provider), now + cooldownMs)
  else if (!r.blocked) until.delete(key(runtime, provider))
}

/** Explicit reset time (e.g. Claude's rate_limit_event resetsAt). */
export function noteQuotaResetAt(runtime: string, provider: string, resetsAtMs: number): void {
  until.set(key(runtime, provider), resetsAtMs)
}

export function quotaCoolingDown(runtime: string, provider: string, now = Date.now()): { cooling: boolean; untilMs?: number } {
  const u = until.get(key(runtime, provider))
  if (!u) return { cooling: false }
  if (u <= now) { until.delete(key(runtime, provider)); return { cooling: false } }
  return { cooling: true, untilMs: u }
}

/** Test hook. */
export function _resetQuotaState(): void { until.clear() }
