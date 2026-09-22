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
  routingApplies,
  shouldSwitch,
  type RoutingDecision,
  type RoutingMode,
  type RoutingSource,
  type TargetPick,
} from '../model-router.js'
import { readAgentSecurityProfile, resolveAgentModelDetailed, readModelProfileMap, resolveModelId } from './agent-config.js'
import { MAIN_AGENT_ID } from '../config.js'
import { jevConfigured, jevSystemOne } from './jev-client.js'
import { resolveProfileTarget, type ModelProfileId, type ProfileTarget, MODEL_PROFILE_IDS } from '../model-profiles.js'
import { availableRuntimeKinds } from '../runtime/registry.js'
import { inferProvider, runtimeSupportsProvider, defaultRuntimeFor, defaultAuthModeFor } from '../runtime/resolve-spec.js'
import { lookupProviderSecret } from '../runtime/secret-ids.js'
import { resolveFleetOauthToken } from '../runtime/claude-headless.js'
import type { ProviderKind, RuntimeKind } from '../runtime/types.js'
import { quotaCoolingDown } from '../runtime/quota-state.js'
import { subscriptionRuntimeAvailability, type SubscriptionRuntimeAvailability } from './runtime-availability.js'
import { evaluateRoutingGate, readRoutingCalibration, type GateVerdict } from './routing-gate.js'

let cachedMode: { configured: RoutingMode; value: RoutingMode; gate: GateVerdict; readAt: number } | null = null
const MODE_CACHE_MS = 30_000
let lastGateWarning = ''

function readModeState(): NonNullable<typeof cachedMode> {
  const now = Date.now()
  if (cachedMode && now - cachedMode.readAt < MODE_CACHE_MS) return cachedMode
  let raw: string | undefined = process.env.MODEL_ROUTING
  if (!raw) {
    try { raw = readEnvFile(['MODEL_ROUTING'])['MODEL_ROUTING'] } catch { raw = undefined }
  }
  const configured = normalizeRoutingMode(raw)
  const gate = evaluateRoutingGate(configured, routingApplies(configured) ? readRoutingCalibration() : null)
  // An apply mode without passing evidence runs as shadow: rows are still
  // written (that is how the evidence accrues), nothing is switched.
  const value: RoutingMode = gate.allowed ? configured : 'shadow'
  if (!gate.allowed && lastGateWarning !== gate.reason) {
    lastGateWarning = gate.reason
    logger.warn({ configured, reason: gate.reason }, 'model-routing: apply mode held at shadow by the measurement gate')
  }
  cachedMode = { configured, value, gate, readAt: now }
  return cachedMode
}

/** The EFFECTIVE mode: MODEL_ROUTING, held at 'shadow' while the measurement gate is closed. */
export function routingMode(): RoutingMode {
  return readModeState().value
}

/** What the operator configured, and why the effective mode may differ (dashboard). */
export function routingModeStatus(): { configured: RoutingMode; effective: RoutingMode; gate: GateVerdict } {
  const s = readModeState()
  return { configured: s.configured, effective: s.value, gate: s.gate }
}

/** Test hook: forget the cached mode/key so a changed env is re-read. */
export function resetRoutingCaches(): void {
  cachedMode = null
  lastGateWarning = ''
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
  /**
   * The profile the agent is CURRENTLY on (headless session agents). When
   * given, shouldSwitch() hysteresis applies: any upgrade, a downgrade only
   * two tiers down -- so a routed agent does not bounce between tiers on
   * every task. Background runs have no current profile (fresh process).
   */
  currentProfile?: ModelProfileId | null
}

/**
 * A target is available when its runtime is shipped and its provider can
 * authenticate on this host (vault key; the fleet OAuth token for Anthropic
 * subscriptions; nothing for Ollama). Quota windows (plan section 7) feed
 * in via quota-state.ts (a recent 429 / usage-limit cools the runtime down).
 */
export function targetAvailability(t: ProfileTarget, deps: {
  availableRuntimes: RuntimeKind[]
  secretLookup: (id: string) => string | null
  fleetOauthToken: string | null
  agentId: string
  /** Seams for tests; production reads the live facts. */
  quota?: (runtime: string, provider: string) => { cooling: boolean }
  cliFacts?: () => Pick<SubscriptionRuntimeAvailability, 'minimax' | 'codex' | 'gemini'>
} ): { available: boolean; runtime: RuntimeKind; provider: ProviderKind; reason?: string } {
  const provider = t.provider ?? inferProvider(t.model)
  const runtime = t.runtime ?? defaultRuntimeFor(provider, defaultAuthModeFor(provider), 'background')
  if (!deps.availableRuntimes.includes(runtime)) return { available: false, runtime, provider, reason: `runtime_unavailable:${runtime}` }
  if (!runtimeSupportsProvider(runtime, provider)) return { available: false, runtime, provider, reason: `runtime_provider_mismatch:${runtime}/${provider}` }
  // A runtime that just answered 429 / usage limit is cooling down: pickTarget
  // climbs to the next stronger available tier instead of walking into it.
  const q = (deps.quota ?? quotaCoolingDown)(runtime, provider)
  if (q.cooling) return { available: false, runtime, provider, reason: `quota_cooldown:${runtime}/${provider}` }
  if (provider === 'ollama') return { available: true, runtime, provider }
  if (provider === 'anthropic' && runtime.startsWith('claude-') && deps.fleetOauthToken) return { available: true, runtime, provider }
  // Subscription CLIs: installed AND logged in (runtime-availability.ts) -- the
  // first version called codex/gemini "always available" and sent a
  // subscription-only minimax target to the API-key check, which failed it.
  const cli = runtime === 'codex-cli' ? 'codex' : runtime === 'gemini-cli' ? 'gemini' : runtime === 'minimax-cli' ? 'minimax' : null
  const key = lookupProviderSecret(provider, deps.agentId, deps.secretLookup)
  if (cli) {
    const facts = (deps.cliFacts ?? (() => subscriptionRuntimeAvailability()))()[cli]
    if (facts.installed && (facts.loggedIn || key)) return { available: true, runtime, provider }
    return { available: false, runtime, provider, reason: facts.installed ? `not_logged_in:${runtime}` : `not_installed:${runtime}` }
  }
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
    if (!routingApplies(mode)) return null
    if (!decision) { stampApplied(input.taskRef, input.source, { kind: 'skip', reason: 'jev_unavailable' }, null); return null }
    const mapState = readModelProfileMap()
    const targets = Object.fromEntries(MODEL_PROFILE_IDS.map((p) => [p, resolveProfileTarget(p, mapState, resolveModelId)])) as Record<string, ProfileTarget | null>
    const { getSecret } = await import('./vault.js')
    const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
    const deps = { availableRuntimes: availableRuntimeKinds(), secretLookup, fleetOauthToken: resolveFleetOauthToken(), agentId: input.agent }
    const pick = pickTarget(decision, targets, (t) => targetAvailability(t, deps).available)
    if (pick.kind !== 'apply') { stampApplied(input.taskRef, input.source, pick, null); return null }
    // Hysteresis for a session agent that already sits on a profile: the
    // decision must clear shouldSwitch() before the agent is moved.
    if (input.currentProfile && pick.profile !== input.currentProfile && !shouldSwitch(input.currentProfile, pick.profile as ModelProfileId, decision)) {
      stampApplied(input.taskRef, input.source, { kind: 'skip', reason: `hysteresis:${input.currentProfile}->${pick.profile}` }, null)
      return null
    }
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
