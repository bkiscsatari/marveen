// Pure logic for complexity-based model routing with Jev (TypeSafe AI's
// System One model). Phase B0 = SHADOW ONLY: every dispatch path asks Jev
// which model PROFILE the task deserves, logs the suggestion next to the
// model the agent actually ran on, and changes nothing. Phase B1 (applying
// the suggestion) is a separate, later decision that this module already
// expresses as a pure policy so it can be unit-tested before it is wired.
//
// Why profiles and not model ids: an agent config may name a generic tier
// (src/model-profiles.ts) and the deployment-local map turns that into a
// concrete vendor model. Jev therefore never learns or emits a model id --
// the map and the operator stay in control ("no silent model change").
//
// Why Jev and not the LLM itself: the routing question must be answered
// BEFORE a model is chosen, for every delegated task, in well under a
// second and for a fraction of a cent. That is exactly the shape of query a
// System One model exists for (typed answer + calibrated confidence, no
// text). Known limits that shaped the question set (docs "jaggedness" page
// and independent calibration studies, 2026-09): one judgment per question,
// literal reading, no abstention unless an escape option exists, weaker on
// Hungarian than English -- the fleet talks Hungarian, so the shadow log is
// what tells us whether the suggestions can be trusted at all.
//
// No fs, no env, no I/O here. The runner (src/web/model-routing.ts) reads
// config, calls the API and writes the log.

import { MODEL_PROFILE_IDS, isModelProfileId, type ModelProfileId } from './model-profiles.js'

export const ROUTING_MODES = ['off', 'shadow'] as const
export type RoutingMode = (typeof ROUTING_MODES)[number]

/** Unknown or empty -> 'off'. Reserved future modes ('background', 'all')
 *  also resolve to 'shadow' so a config written ahead of B1 cannot switch
 *  anything live by accident. */
export function normalizeRoutingMode(raw: unknown): RoutingMode {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'shadow' || v === 'background' || v === 'all') return 'shadow'
  return 'off'
}

export type RoutingSource = 'inter_agent' | 'kanban' | 'background'

export interface RoutingTask {
  source: RoutingSource
  /** Target agent id (sub-agent) or the main agent id. */
  agent: string
  /** Role hint: securityProfile / displayName, e.g. "researcher", "developer-junior". */
  role: string
  /** The task text as the agent will receive it. */
  text: string
}

// Jev's per-request budget is ~64k tokens shared with the questions; a
// delegated task rarely needs more than the first few thousand characters
// to be classified, and shorter state is also what the docs recommend
// ("large irrelevant state degrades accuracy").
export const MAX_STATE_CHARS = 6000

// Anything that looks like a credential is masked before it leaves the
// machine. Coarse on purpose: a false positive costs a little routing
// accuracy, a false negative ships a secret to a third party.
const SECRET_RX = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Za-z0-9_-]{32,}:[A-Za-z0-9_-]{32,}|\d{9,10}:[A-Za-z0-9_-]{35,})\b/g
const KV_SECRET_RX = /\b((?:api[_-]?key|token|secret|password|passwd|bearer)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi

export function scrubSecrets(text: string): string {
  return text.replace(KV_SECRET_RX, '$1$2[redacted]$2').replace(SECRET_RX, '[redacted]')
}

export function buildRoutingState(task: RoutingTask): Record<string, string> {
  const clipped = task.text.length > MAX_STATE_CHARS ? task.text.slice(0, MAX_STATE_CHARS) + ' [truncated]' : task.text
  return {
    source: task.source,
    target_agent: task.agent,
    target_role: task.role,
    task: scrubSecrets(clipped),
  }
}

// One judgment per question (Jev cannot decompose a compound question on
// its own). The profile choice is the primary answer; the nouls are the
// atomic signals the policy below uses as guard rails, and the score gives
// a second, ordinal view of the same thing for the calibration report.
export const PROFILE_CRITERIA: Record<ModelProfileId | 'needs_review', string> = {
  routine_lowcost:
    'Trivial or mechanical: a status check, a short lookup, a one-line edit, a reminder, forwarding information. No reasoning about trade-offs, no multi-file code change.',
  analysis_efficient:
    'Moderate: summarising, classifying, drafting short text, a small well-specified code fix, a research lookup with a clear answer. Some judgment, low ambiguity.',
  build_strong:
    'Substantial: implementing a feature across several files, debugging with unknown cause, multi-step research with synthesis, writing long structured content. Needs sustained reasoning and tool use.',
  premium_reasoning:
    'Hard or high-stakes: architecture decisions, security-sensitive changes, ambiguous requirements that must be resolved, tasks where a wrong answer is expensive to undo.',
  needs_review:
    'The text is not a task at all (greeting, acknowledgement, empty, off-topic) or is too ambiguous to place in any tier.',
}

export const COMPLEXITY_LEVELS = ['trivial', 'moderate', 'substantial', 'expert'] as const

export function buildRoutingQuestions(): Record<string, unknown> {
  return {
    profile: {
      type: 'choice',
      instructions:
        'Which capability tier does the `task` need to be completed correctly by an AI coding/research agent with the `target_role`? Judge the task, not the agent.',
      criteria: PROFILE_CRITERIA,
    },
    complexity: {
      type: 'score',
      instructions: 'How complex is the `task` for an AI agent, from trivial to expert-level?',
      criteria: [...COMPLEXITY_LEVELS],
    },
    multi_step: {
      type: 'noul',
      instructions: 'Does completing the `task` require several dependent steps or tool calls rather than a single action or answer?',
    },
    needs_code_change: {
      type: 'noul',
      instructions: 'Does the `task` require writing or modifying source code, configuration or infrastructure?',
    },
    needs_web_research: {
      type: 'noul',
      instructions: 'Does the `task` require searching or reading external web sources to answer?',
    },
    risky_action: {
      type: 'noul',
      instructions:
        'Could the `task`, if done wrong, cause damage that is hard to undo: deleting data, sending messages or emails to people, publishing content, changing production systems, spending money, or touching credentials?',
    },
  }
}

export interface RoutingAnswers {
  profile: string | null
  profileConfidence: number | null
  profileProbabilities: Record<string, number> | null
  complexity: number | null
  multiStep: number | null
  needsCodeChange: number | null
  needsWebResearch: number | null
  riskyAction: number | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Tolerant parse of a /v1/systemone `answers` object; missing keys -> null. */
export function parseRoutingAnswers(answers: unknown): RoutingAnswers {
  const a = (answers && typeof answers === 'object' ? answers : {}) as Record<string, Record<string, unknown>>
  const get = (k: string) => (a[k] && typeof a[k] === 'object' ? a[k] : {})
  const profile = get('profile')
  const probs = profile.probabilities
  return {
    profile: typeof profile.choice === 'string' ? profile.choice : null,
    profileConfidence: num(profile.confidence),
    profileProbabilities:
      probs && typeof probs === 'object'
        ? Object.fromEntries(Object.entries(probs as Record<string, unknown>).map(([k, v]) => [k, num(v) ?? 0]))
        : null,
    complexity: num(get('complexity').score),
    multiStep: num(get('multi_step').noul),
    needsCodeChange: num(get('needs_code_change').noul),
    needsWebResearch: num(get('needs_web_research').noul),
    riskyAction: num(get('risky_action').noul),
  }
}

export interface RoutingDecision {
  /** null when Jev could not place the task (needs_review / no answer). */
  profile: ModelProfileId | null
  confidence: number
  needsReview: boolean
  /** Whether B1 would be allowed to act on this decision (confidence gate). */
  actionable: boolean
  reasons: string[]
}

export const DEFAULT_MIN_CONFIDENCE = 0.6
// A "risky" task never gets routed below this tier, whatever Jev's
// profile answer said: the cost of an under-powered model on a destructive
// task is not symmetric with the cost of an over-powered one on a trivial task.
export const RISKY_FLOOR: ModelProfileId = 'build_strong'
export const NOUL_THRESHOLD = 0.5

export function profileRank(p: ModelProfileId): number {
  return MODEL_PROFILE_IDS.indexOf(p) // premium_reasoning=0 ... routine_lowcost=3
}

/** Lower rank index = stronger tier. Returns the stronger of the two. */
export function strongerOf(a: ModelProfileId, b: ModelProfileId): ModelProfileId {
  return profileRank(a) <= profileRank(b) ? a : b
}

export function decideProfile(
  ans: RoutingAnswers,
  opts: { minConfidence?: number } = {},
): RoutingDecision {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const reasons: string[] = []
  const confidence = ans.profileConfidence ?? 0
  if (!ans.profile || ans.profile === 'needs_review' || !isModelProfileId(ans.profile)) {
    reasons.push(ans.profile ? `jev answered ${ans.profile}` : 'no profile answer')
    return { profile: null, confidence, needsReview: true, actionable: false, reasons }
  }
  let profile: ModelProfileId = ans.profile
  reasons.push(`jev: ${profile} (${confidence.toFixed(2)})`)
  if ((ans.riskyAction ?? 0) >= NOUL_THRESHOLD) {
    const floored = strongerOf(profile, RISKY_FLOOR)
    if (floored !== profile) reasons.push(`risky_action ${ans.riskyAction!.toFixed(2)} -> floor ${RISKY_FLOOR}`)
    profile = floored
  }
  const actionable = confidence >= minConfidence
  if (!actionable) reasons.push(`confidence below ${minConfidence}`)
  return { profile, confidence, needsReview: false, actionable, reasons }
}

/**
 * B1 policy (NOT wired in B0): whether a suggestion should move an agent
 * from `current` to `suggested`. Upward moves (stronger tier) apply on any
 * actionable decision; downward moves need two full tiers of difference so
 * a borderline call cannot flap an agent between neighbouring models.
 */
export function shouldSwitch(current: ModelProfileId, suggested: ModelProfileId, decision: RoutingDecision): boolean {
  if (!decision.actionable || decision.profile !== suggested) return false
  const diff = profileRank(current) - profileRank(suggested) // >0 = suggested is stronger
  if (diff > 0) return true
  return diff <= -2
}
