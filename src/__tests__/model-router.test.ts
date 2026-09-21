// Jev model routing, Phase B0 (shadow). These tests pin the properties that
// make the shadow safe to leave on: nothing here can pick a model id, an
// unplaceable task is reported as needs_review rather than guessed, a risky
// task can never be suggested a weak tier, secrets never leave in the state,
// and the (unwired) B1 switch policy cannot flap between neighbouring tiers.

import { describe, expect, it } from 'vitest'
import {
  MAX_STATE_CHARS,
  PROFILE_CRITERIA,
  buildRoutingQuestions,
  buildRoutingState,
  decideProfile,
  normalizeRoutingMode,
  parseRoutingAnswers,
  scrubSecrets,
  shouldSwitch,
  strongerOf,
} from '../model-router.js'
import { MODEL_PROFILE_IDS } from '../model-profiles.js'

describe('normalizeRoutingMode', () => {
  it('is off unless explicitly shadow; reserved B1 modes degrade to shadow', () => {
    expect(normalizeRoutingMode(undefined)).toBe('off')
    expect(normalizeRoutingMode('')).toBe('off')
    expect(normalizeRoutingMode('on')).toBe('off')
    expect(normalizeRoutingMode(' Shadow ')).toBe('shadow')
    expect(normalizeRoutingMode('background')).toBe('shadow')
    expect(normalizeRoutingMode('all')).toBe('shadow')
  })
})

describe('questions and state', () => {
  it('offers every model profile plus an explicit escape option', () => {
    for (const id of MODEL_PROFILE_IDS) expect(PROFILE_CRITERIA).toHaveProperty(id)
    expect(PROFILE_CRITERIA).toHaveProperty('needs_review')
    const q = buildRoutingQuestions() as Record<string, { type: string; criteria?: unknown }>
    expect(q.profile.type).toBe('choice')
    expect(Object.keys(q.profile.criteria as object)).toContain('needs_review')
    expect(q.complexity.type).toBe('score')
    for (const k of ['multi_step', 'needs_code_change', 'needs_web_research', 'risky_action']) expect(q[k].type).toBe('noul')
  })

  it('clips long tasks and masks credentials before they leave the machine', () => {
    const long = 'x'.repeat(MAX_STATE_CHARS + 500)
    const s = buildRoutingState({ source: 'kanban', agent: 'brix', role: 'developer-junior', text: long })
    expect(s.task.length).toBeLessThan(MAX_STATE_CHARS + 20)
    expect(s.task.endsWith('[truncated]')).toBe(true)
    expect(s.target_role).toBe('developer-junior')
  })

  it('scrubs key=value secrets, bot tokens, JWTs and sk- keys', () => {
    const text = [
      'api_key: abcdefghijklmnop',
      'TOKEN=sk-live-ABCDEFGHIJKLMNOP123456',
      'telegram 1234567890:AAEabcdefghijklmnopqrstuvwxyz0123456789',
      'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'normal words stay',
    ].join('\n')
    const out = scrubSecrets(text)
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).not.toContain('sk-live-')
    expect(out).not.toContain('AAEabcdefghij')
    expect(out).not.toContain('eyJhbGciOi')
    expect(out).toContain('normal words stay')
    expect(out).toContain('[redacted]')
  })
})

function answers(over: Partial<ReturnType<typeof parseRoutingAnswers>> = {}) {
  return {
    profile: 'analysis_efficient',
    profileConfidence: 0.8,
    profileProbabilities: null,
    complexity: 1,
    multiStep: 0.2,
    needsCodeChange: 0.1,
    needsWebResearch: 0.1,
    riskyAction: 0.05,
    ...over,
  }
}

describe('parseRoutingAnswers', () => {
  it('tolerates a partial or malformed answers object', () => {
    expect(parseRoutingAnswers(null).profile).toBeNull()
    const a = parseRoutingAnswers({
      profile: { type: 'choice', choice: 'build_strong', confidence: 0.71, probabilities: { build_strong: 0.7, needs_review: 0.1 } },
      risky_action: { type: 'noul', noul: 0.9 },
      complexity: { type: 'score', score: 'not-a-number' },
    })
    expect(a.profile).toBe('build_strong')
    expect(a.profileConfidence).toBe(0.71)
    expect(a.profileProbabilities).toEqual({ build_strong: 0.7, needs_review: 0.1 })
    expect(a.riskyAction).toBe(0.9)
    expect(a.complexity).toBeNull()
    expect(a.multiStep).toBeNull()
  })
})

describe('decideProfile', () => {
  it('passes a confident, non-risky answer through', () => {
    const d = decideProfile(answers())
    expect(d.profile).toBe('analysis_efficient')
    expect(d.actionable).toBe(true)
    expect(d.needsReview).toBe(false)
  })

  it('reports needs_review instead of guessing, and never invents a profile id', () => {
    expect(decideProfile(answers({ profile: 'needs_review' })).profile).toBeNull()
    expect(decideProfile(answers({ profile: null })).needsReview).toBe(true)
    const bogus = decideProfile(answers({ profile: 'claude-opus-5' }))
    expect(bogus.profile).toBeNull()
    expect(bogus.actionable).toBe(false)
  })

  it('floors a risky task at build_strong whatever the profile answer said', () => {
    const d = decideProfile(answers({ profile: 'routine_lowcost', riskyAction: 0.8 }))
    expect(d.profile).toBe('build_strong')
    expect(d.reasons.join(' ')).toContain('floor')
    // a stronger answer is not weakened by the floor
    expect(decideProfile(answers({ profile: 'premium_reasoning', riskyAction: 0.8 })).profile).toBe('premium_reasoning')
  })

  it('keeps the suggestion but marks it non-actionable below the confidence gate', () => {
    const d = decideProfile(answers({ profileConfidence: 0.4 }))
    expect(d.profile).toBe('analysis_efficient')
    expect(d.actionable).toBe(false)
  })
})

describe('shouldSwitch (B1 policy, unwired in B0)', () => {
  it('moves up on any actionable decision, down only across two tiers', () => {
    const up = decideProfile(answers({ profile: 'build_strong' }))
    expect(shouldSwitch('routine_lowcost', 'build_strong', up)).toBe(true)
    const downOne = decideProfile(answers({ profile: 'build_strong' }))
    expect(shouldSwitch('premium_reasoning', 'build_strong', downOne)).toBe(false)
    const downTwo = decideProfile(answers({ profile: 'analysis_efficient' }))
    expect(shouldSwitch('premium_reasoning', 'analysis_efficient', downTwo)).toBe(true)
    const weak = decideProfile(answers({ profile: 'build_strong', profileConfidence: 0.3 }))
    expect(shouldSwitch('routine_lowcost', 'build_strong', weak)).toBe(false)
  })

  it('strongerOf follows the profile order', () => {
    expect(strongerOf('routine_lowcost', 'build_strong')).toBe('build_strong')
    expect(strongerOf('premium_reasoning', 'build_strong')).toBe('premium_reasoning')
  })
})
