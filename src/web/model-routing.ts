// Runner for the Jev model routing (Phase B0 shadow + Phase B1 `background`).
// See src/model-router.ts for the why. This file owns the I/O: config, the
// API call, the log row, and -- in B1 -- the (runtime, provider, model)
// override a background task actually runs with.
//
// Contracts:
//  - `shadowRoute()` (B0, unchanged): synchronous from the caller's point of
//    view, returns immediately; the classification runs detached and its only
//    side effect is a row in model_routing_log.
//  - `routeForRun()` (B1): awaited by the background-task runtime path. In
//    'shadow' mode it logs and returns null (no override). In 'background'
//    mode an actionable, available target is returned and the row carries
//    applied=1 + applied_runtime/applied_model; otherwise fallback_reason
//    says why the agent's own default ran. Any throw -> null (never blocks).

import { createHash } from 'node:crypto'
import { getDb, insertModelRoutingLog } from '../db.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import {
  buildRoutingQuestions,
  buildRoutingState,
  decideProfile,
  normalizeRoutingMode,
  pickTarget,
  type RoutingDecision,
  type RoutingMode,
  type RoutingSource,
  type TargetPick,
} from '../model-router.js'
import { readAgentSecurityProfile, resolveAgentModelDetailed, readModelProfileMap, resolveModelId } from './agent-config.js'
import { MAIN_AGENT_ID } from '../config.js'
import { jevConfigured, jevSystemOne } from './jev-client.js'
import { resolveProfileTarget, type ProfileTarget, MODEL_PROFILE_IDS } from '../model-profiles.js'
import { availableRuntimeKinds } from '../runtime/registry.js'
import { inferProvider, runtimeSupportsProvider, defaultRuntimeFor, defaultAuthModeFor } from '../runtime/resolve-spec.js'
import { lookupProviderSecret } from '../runtime/secret-ids.js'
import { resolveFleetOauthToken } from '../runtime/claude-headless.js'
import type { ProviderKind, RuntimeKind } from '../runtime/types.js'

let cachedMode: { value: RoutingMode; readAt: number } | null = null
const MODE_CACHE_MS = 30_000

export function routingMode(): RoutingMode {
  const now = Date.now()
  if (cachedMode && now - cachedMode.readAt < MODE_CACHE_MS) return cachedMode.value
  let raw: string | undefined = process.env.MODEL_ROUTING
  if (!raw) {
    try { raw = readEnvFile(['MODEL_ROUTING'])['MODEL_ROUTING'] } catch { raw = undefined }
  }
  const value = normalizeRoutingMode(raw)
  cachedMode = { value, readAt: now }
  return value
}

/** Test hook: forget the cached mode/key so a changed env is re-read. */
export function resetRoutingCaches(): void {
  cachedMode = null
}

export interface ShadowRouteInput {
  source: RoutingSource
  agent: string
  text: string
  /** Message id / card id / background task id -- whatever lets the report join back. */
  taskRef: string
}

function roleFor(agent: string): string {
  if (agent === MAIN_AGENT_ID) return 'main-orchestrator'
  try { return readAgentSecurityProfile(agent) || 'unknown' } catch { return 'unknown' }
}

function currentModelFor(agent: string): string {
  try { return resolveAgentModelDetailed(agent).model } catch { return '' }
}

export function shadowRoute(input: ShadowRouteInput): void {
  if (routingMode() === 'off') return
  if (!jevConfigured()) return
  if (!input.text || !input.text.trim()) return
  void classifyAndLog(input).catch((err) => {
    logger.warn({ err: String(err), agent: input.agent, source: input.source }, 'model-routing: shadow run threw')
  })
}

/** Ask Jev, write the B0 row, return the decision (null when Jev was unavailable). */
async function classifyAndLog(input: ShadowRouteInput): Promise<RoutingDecision | null> {
  const role = roleFor(input.agent)
  const state = buildRoutingState({ source: input.source, agent: input.agent, role, text: input.text })
  const questions = buildRoutingQuestions()
  const taskDigest = createHash('sha256').update(input.text).digest('hex').slice(0, 16)
  const currentModel = currentModelFor(input.agent)
  const res = await jevSystemOne(state, questions)
  if (!res) {
    insertModelRoutingLog({
      source: input.source, agent: input.agent, task_ref: input.taskRef, task_digest: taskDigest,
      text_preview: state.task.slice(0, 120), suggested_profile: null, confidence: null, complexity: null,
      needs_review: 0, actionable: 0, flags: null, reasons: null, current_model: currentModel, role,
      jev_model: null, latency_ms: null, input_tokens: null, cost_usd: null, error: 'jev unavailable',
    })
    return null
  }
  const { parseRoutingAnswers } = await import('../model-router.js')
  const answers = parseRoutingAnswers(res.answers)
  const decision = decideProfile(answers)
  insertModelRoutingLog({
    source: input.source, agent: input.agent, task_ref: input.taskRef, task_digest: taskDigest,
    text_preview: state.task.slice(0, 120),
    suggested_profile: decision.profile, confidence: decision.confidence, complexity: answers.complexity,
    needs_review: decision.needsReview ? 1 : 0, actionable: decision.actionable ? 1 : 0,
    flags: JSON.stringify({
      multi_step: answers.multiStep, needs_code_change: answers.needsCodeChange,
      needs_web_research: answers.needsWebResearch, risky_action: answers.riskyAction,
      profile_probabilities: answers.profileProbabilities,
    }),
    reasons: decision.reasons.join('; '), current_model: currentModel, role,
    jev_model: res.model, latency_ms: res.latencyMs, input_tokens: res.inputTokens, cost_usd: res.costUsd, error: null,
  })
  logger.info(
    { agent: input.agent, source: input.source, taskRef: input.taskRef, profile: decision.profile, confidence: decision.confidence, latencyMs: res.latencyMs },
    'model-routing: suggestion logged',
  )
  return decision
}

// --- B1: apply to a background run ---------------------------------------------

export interface RouteOverride {
  profile: string
  runtime: RuntimeKind
  provider: ProviderKind
  model: string
}

export interface RouteForRunInput extends ShadowRouteInput {
  /** What the agent would run with without routing. */
  current: { runtime: RuntimeKind; provider: ProviderKind; model: string }
}

/**
 * A target is available when its runtime is shipped and its provider can
 * authenticate on this host (vault key; the fleet OAuth token for Anthropic
 * subscriptions; nothing for Ollama). Quota windows (plan section 7) feed
 * in here later; today a target that IS configured is assumed to have budget.
 */
export function targetAvailability(t: ProfileTarget, deps: {
  availableRuntimes: RuntimeKind[]
  secretLookup: (id: string) => string | null
  fleetOauthToken: string | null
  agentId: string
} ): { available: boolean; runtime: RuntimeKind; provider: ProviderKind; reason?: string } {
  const provider = t.provider ?? inferProvider(t.model)
  const runtime = t.runtime ?? defaultRuntimeFor(provider, defaultAuthModeFor(provider), 'background')
  if (!deps.availableRuntimes.includes(runtime)) return { available: false, runtime, provider, reason: `runtime_unavailable:${runtime}` }
  if (!runtimeSupportsProvider(runtime, provider)) return { available: false, runtime, provider, reason: `runtime_provider_mismatch:${runtime}/${provider}` }
  if (provider === 'ollama') return { available: true, runtime, provider }
  if (provider === 'anthropic' && runtime.startsWith('claude-') && deps.fleetOauthToken) return { available: true, runtime, provider }
  if (runtime === 'codex-cli' || runtime === 'gemini-cli') return { available: true, runtime, provider } // login checked by the adapter's healthProbe
  const key = lookupProviderSecret(provider, deps.agentId, deps.secretLookup)
  return key ? { available: true, runtime, provider } : { available: false, runtime, provider, reason: `no_api_key:${provider}` }
}

function stampApplied(taskRef: string, source: RoutingSource, pick: TargetPick, override: RouteOverride | null): void {
  try {
    getDb().prepare(`
      UPDATE model_routing_log SET applied = ?, applied_runtime = ?, applied_model = ?, fallback_reason = ?
      WHERE id = (SELECT id FROM model_routing_log WHERE task_ref = ? AND source = ? ORDER BY id DESC LIMIT 1)
    `).run(override ? 1 : 0, override?.runtime ?? null, override?.model ?? null, pick.kind === 'apply' ? null : pick.reason, taskRef, source)
  } catch (err) {
    logger.debug({ err }, 'model-routing: could not stamp applied columns')
  }
}

/**
 * B1 entry point for the background-task runtime path. Never throws, never
 * blocks longer than Jev's own timeout; null = run the agent's default.
 */
export async function routeForRun(input: RouteForRunInput): Promise<RouteOverride | null> {
  try {
    const mode = routingMode()
    if (mode === 'off' || !jevConfigured() || !input.text.trim()) return null
    const decision = await classifyAndLog(input)
    if (mode !== 'background' && mode !== 'all') return null
    if (!decision) { stampApplied(input.taskRef, input.source, { kind: 'skip', reason: 'jev_unavailable' }, null); return null }
    const mapState = readModelProfileMap()
    const targets = Object.fromEntries(MODEL_PROFILE_IDS.map((p) => [p, resolveProfileTarget(p, mapState, resolveModelId)])) as Record<string, ProfileTarget | null>
    const { getSecret } = await import('./vault.js')
    const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
    const deps = { availableRuntimes: availableRuntimeKinds(), secretLookup, fleetOauthToken: resolveFleetOauthToken(), agentId: input.agent }
    const pick = pickTarget(decision, targets, (t) => targetAvailability(t, deps).available)
    if (pick.kind !== 'apply') { stampApplied(input.taskRef, input.source, pick, null); return null }
    const avail = targetAvailability(pick.target, deps)
    const override: RouteOverride = { profile: pick.profile, runtime: avail.runtime, provider: avail.provider, model: pick.target.model }
    stampApplied(input.taskRef, input.source, pick, override)
    logger.info({ agent: input.agent, taskRef: input.taskRef, ...override, from: input.current }, 'model-routing: B1 override applied to background run')
    return override
  } catch (err) {
    logger.warn({ err: String(err), agent: input.agent }, 'model-routing: routeForRun threw -- running the default')
    return null
  }
}
