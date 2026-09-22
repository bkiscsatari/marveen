// The Jev B1 measurement gate, in code: an apply mode (background|all) is held
// at shadow until store/model-routing-calibration.json shows >= 100 labelled
// rows, a held-out measurement and the owner's approval for that mode.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { evaluateRoutingGate, MIN_LABELLED_ROWS } from '../web/routing-gate.js'
import { routingMode, routingModeStatus, resetRoutingCaches } from '../web/model-routing.js'
import { decideProfile, pickTarget, shouldSwitch, type RoutingAnswers } from '../model-router.js'

const PASSING = {
  labelledRows: 140, fitRows: 70, holdoutRows: 70, holdoutAgreement: 0.72,
  generatedAt: '2026-10-01T10:00:00Z', approvedAt: '2026-10-02', approvedModes: ['background'],
}

describe('evaluateRoutingGate', () => {
  it('never blocks the non-apply modes', () => {
    expect(evaluateRoutingGate('off', null).allowed).toBe(true)
    expect(evaluateRoutingGate('shadow', null).allowed).toBe(true)
  })

  it('holds an apply mode without a calibration file', () => {
    const v = evaluateRoutingGate('background', null)
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/no calibration file/)
  })

  it('requires the labelled-row minimum, a held-out measurement and an approval', () => {
    expect(evaluateRoutingGate('background', { ...PASSING, labelledRows: MIN_LABELLED_ROWS - 1 }).allowed).toBe(false)
    expect(evaluateRoutingGate('background', { ...PASSING, labelledRows: '140' }).allowed).toBe(false)
    expect(evaluateRoutingGate('background', { ...PASSING, holdoutRows: 0 }).allowed).toBe(false)
    expect(evaluateRoutingGate('background', { ...PASSING, holdoutAgreement: undefined }).allowed).toBe(false)
    expect(evaluateRoutingGate('background', { ...PASSING, approvedAt: '' }).allowed).toBe(false)
    expect(evaluateRoutingGate('background', PASSING).allowed).toBe(true)
  })

  it('approval is per mode: background does not open all, all covers background', () => {
    expect(evaluateRoutingGate('all', PASSING).allowed).toBe(false)
    expect(evaluateRoutingGate('background', { ...PASSING, approvedModes: ['all'] }).allowed).toBe(true)
    expect(evaluateRoutingGate('all', { ...PASSING, approvedModes: ['all'] }).allowed).toBe(true)
  })
})

describe('routingMode() is the EFFECTIVE mode', () => {
  const saved = process.env.MODEL_ROUTING
  beforeEach(() => resetRoutingCaches())
  afterEach(() => { if (saved === undefined) delete process.env.MODEL_ROUTING; else process.env.MODEL_ROUTING = saved; resetRoutingCaches() })

  it('MODEL_ROUTING=all without evidence runs as shadow and says why', () => {
    process.env.MODEL_ROUTING = 'all'
    expect(routingMode()).toBe('shadow')
    const s = routingModeStatus()
    expect(s.configured).toBe('all')
    expect(s.effective).toBe('shadow')
    expect(s.gate.allowed).toBe(false)
  })

  it('shadow and off pass through unchanged', () => {
    process.env.MODEL_ROUTING = 'shadow'
    expect(routingMode()).toBe('shadow')
    resetRoutingCaches()
    process.env.MODEL_ROUTING = 'off'
    expect(routingMode()).toBe('off')
  })
})

function answers(p: Partial<RoutingAnswers>): RoutingAnswers {
  return { profile: 'analysis_efficient', profileConfidence: 0.9, profileProbabilities: {}, complexity: null, multiStep: null, needsCodeChange: null, needsWebResearch: null, riskyAction: 0, ...p } as RoutingAnswers
}

describe('hysteresis vs. the upward climb (regression)', () => {
  const T = (m: string) => ({ model: m })
  it('a target pickTarget climbed to is accepted by shouldSwitch', () => {
    const decision = decideProfile(answers({ profile: 'analysis_efficient' }))
    // analysis_efficient unavailable -> climbs to build_strong
    const pick = pickTarget(decision, { analysis_efficient: T('a'), build_strong: T('b') }, (t) => t.model === 'b')
    expect(pick.kind).toBe('apply')
    if (pick.kind !== 'apply') return
    expect(pick.profile).toBe('build_strong')
    // agent sits on routine_lowcost: the climbed target is an upgrade and must pass
    expect(shouldSwitch('routine_lowcost', pick.profile, decision)).toBe(true)
  })

  it('a target weaker than Jev asked for is never accepted', () => {
    const decision = decideProfile(answers({ profile: 'build_strong' }))
    expect(shouldSwitch('premium_reasoning', 'routine_lowcost', decision)).toBe(false)
  })

  it('a suggested tier missing from the map climbs like an unavailable one', () => {
    const decision = decideProfile(answers({ profile: 'routine_lowcost' }))
    const pick = pickTarget(decision, { analysis_efficient: T('a') }, () => true)
    expect(pick.kind === 'apply' && pick.profile).toBe('analysis_efficient')
    expect(pickTarget(decision, {}, () => true)).toEqual({ kind: 'skip', reason: 'profile_map_missing:routine_lowcost' })
  })
})
