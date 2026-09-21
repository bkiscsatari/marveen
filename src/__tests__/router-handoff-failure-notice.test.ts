// Contract tests for formatHandoffFailureNotices: when an inter-agent message
// is finally abandoned, the SENDER must be told, not only the orchestrator.
//
// Root cause (card 98eeb2b5, measured 2026-09-20): brix sent ids 1803 and 1804
// to a non-existent agent. Both died after the retry window, and both
// [handoff-failure] notices (1849/1850) went to icuka's inbox. Brix never
// learned that its own two messages were gone -- and nothing on the sender's
// side contradicts "I sent it, so it arrived": the send receipt measures
// acceptance into the queue, not delivery.

import { describe, it, expect } from 'vitest'
import { formatHandoffFailureNotices } from '../web/message-router.js'

const MAIN = 'icuka'
const REASON = 'target session was absent for the entire retry window'

function msg(over: Partial<{ id: number; from_agent: string; to_agent: string; content: string }> = {}) {
  return { id: 1803, from_agent: 'brix', to_agent: 'nincs-ilyen-agens', content: 'Kérlek mérd vissza a lábléc-oszlopot.', ...over }
}

describe('formatHandoffFailureNotices: the sender learns its own message died', () => {
  it('notifies both the orchestrator and the sender', () => {
    const notices = formatHandoffFailureNotices(msg(), MAIN, REASON)
    expect(notices.map((n) => n.to)).toEqual([MAIN, 'brix'])
  })

  it("the sender's copy says it is final and that the receipt did not measure delivery", () => {
    const sender = formatHandoffFailureNotices(msg(), MAIN, REASON).find((n) => n.to === 'brix')!
    expect(sender.text).toContain('id 1803')
    expect(sender.text).toContain('nincs-ilyen-agens')
    expect(sender.text).toContain(REASON)
    expect(sender.text).toMatch(/not delivery/i)
    // The preview is what lets the sender recognize WHICH message was lost.
    expect(sender.text).toContain('lábléc-oszlopot')
  })

  it('keeps the orchestrator copy byte-identical to the pre-fix wording', () => {
    const orch = formatHandoffFailureNotices(msg(), MAIN, REASON)[0]
    expect(orch.to).toBe(MAIN)
    expect(orch.text).toBe(
      `[handoff-failure] Inter-agent message (id 1803) brix -> nincs-ilyen-agens could NOT be delivered: ${REASON}. ` +
      'Consider re-sending or checking the target agent. Content preview: Kérlek mérd vissza a lábléc-oszlopot.',
    )
  })

  it('sends only one notice when the orchestrator itself was the sender', () => {
    const notices = formatHandoffFailureNotices(msg({ from_agent: MAIN }), MAIN, REASON)
    expect(notices.map((n) => n.to)).toEqual([MAIN])
  })

  it("never addresses a copy to 'system' or across the bridge", () => {
    expect(formatHandoffFailureNotices(msg({ from_agent: 'system' }), MAIN, REASON).map((n) => n.to)).toEqual([MAIN])
    expect(formatHandoffFailureNotices(msg({ from_agent: 'tavoli/brix' }), MAIN, REASON).map((n) => n.to)).toEqual([MAIN])
  })

  it('stays silent when the dead message was addressed to the main agent (pull model)', () => {
    expect(formatHandoffFailureNotices(msg({ to_agent: MAIN }), MAIN, REASON)).toEqual([])
  })

  it('truncates the preview at 220 characters in both copies', () => {
    const long = 'x'.repeat(400)
    const notices = formatHandoffFailureNotices(msg({ content: long }), MAIN, REASON)
    for (const n of notices) expect(n.text).toContain('x'.repeat(220))
    for (const n of notices) expect(n.text).not.toContain('x'.repeat(221))
  })
})
