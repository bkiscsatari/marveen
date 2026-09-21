// Runner for the Jev model-routing shadow (Phase B0). See src/model-router.ts
// for the why. This file owns the I/O: config, the API call, the log row.
//
// Contract with the three call sites (message-router, kanban dispatch,
// background tasks): `shadowRoute()` is synchronous from the caller's point
// of view and returns immediately -- the classification runs detached and
// its only side effect is a row in model_routing_log. A throw anywhere in
// here is caught and logged; the delivery it shadows has already happened.

import { createHash } from 'node:crypto'
import { insertModelRoutingLog } from '../db.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import {
  buildRoutingQuestions,
  buildRoutingState,
  decideProfile,
  normalizeRoutingMode,
  parseRoutingAnswers,
  type RoutingMode,
  type RoutingSource,
} from '../model-router.js'
import { readAgentSecurityProfile, resolveAgentModelDetailed } from './agent-config.js'
import { MAIN_AGENT_ID } from '../config.js'
import { jevConfigured, jevSystemOne } from './jev-client.js'

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
  void runShadow(input).catch((err) => {
    logger.warn({ err: String(err), agent: input.agent, source: input.source }, 'model-routing: shadow run threw')
  })
}

async function runShadow(input: ShadowRouteInput): Promise<void> {
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
    return
  }
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
    'model-routing: shadow suggestion logged',
  )
}
