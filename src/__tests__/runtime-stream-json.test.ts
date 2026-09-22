import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClaudeStreamAccumulator,
  parseStreamLine,
  summaryToRunResult,
  streamShowsAuthFailure,
  usageFromResult,
} from '../runtime/stream-json.js'

// Recorded live on 2026-09-22 from Claude Code 2.1.278 (`claude -p
// --output-format stream-json --verbose`). Re-record with
// scripts/record-runtime-fixture.sh when the CLI changes its event shapes.
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-headless')

function feed(name: string, onText?: (t: string) => void) {
  const acc = new ClaudeStreamAccumulator({ onText })
  for (const line of readFileSync(join(FIX, name), 'utf-8').split('\n')) acc.push(line)
  return acc.summary()
}

const CTX = { runtime: 'claude-headless' as const, provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001' }

describe('parseStreamLine', () => {
  it('returns null for blank and non-JSON lines, never throws', () => {
    expect(parseStreamLine('')).toBeNull()
    expect(parseStreamLine('   ')).toBeNull()
    expect(parseStreamLine('not json')).toBeNull()
    expect(parseStreamLine('{"no":"type"}')).toBeNull()
  })
  it('parses a typed event', () => {
    expect(parseStreamLine('{"type":"result","subtype":"success"}')).toEqual({ type: 'result', subtype: 'success' })
  })
})

describe('text-ok.jsonl: plain reply', () => {
  const s = feed('text-ok.jsonl')
  it('captures session id, real model, and the visible text (thinking skipped)', () => {
    expect(s.sessionId).toBe('bf045008-3a96-4f5c-9ba2-9a965a47c027')
    expect(s.model).toBe('claude-haiku-4-5-20251001')
    expect(s.textParts).toEqual(['OK'])
    expect(s.toolCalls).toEqual([])
    expect(s.results).toHaveLength(1)
    expect(s.malformedLines).toBe(0)
  })
  it('keeps the subscription rate-limit windows', () => {
    expect(s.rateLimit?.unifiedWindows?.five_hour?.utilization).toBe(0.06)
    expect(s.rateLimit?.unifiedWindows?.seven_day?.utilization).toBe(0.02)
    expect(s.rateLimit?.rateLimitType).toBe('five_hour')
  })
  it('folds into a usable RunResult with usage + cost', () => {
    const r = summaryToRunResult(s, { ...CTX, timestamp: 1000 })
    expect(r.blocked).toBe(false)
    expect(r.text).toBe('OK')
    expect(r.sessionRef).toBe('bf045008-3a96-4f5c-9ba2-9a965a47c027')
    expect(r.usage).toMatchObject({
      inputTokens: 10, outputTokens: 41, cacheCreationTokens: 6949, cacheReadTokens: 13689, thinkingTokens: 34,
      model: 'claude-haiku-4-5-20251001', provider: 'anthropic', runtime: 'claude-headless', timestamp: 1000,
    })
    expect(r.usage?.costUsd).toBeCloseTo(0.0154819, 6)
  })
  it('streams text chunks to onText as they arrive', () => {
    const chunks: string[] = []
    feed('text-ok.jsonl', (t) => chunks.push(t))
    expect(chunks).toEqual(['OK'])
  })
})

describe('tool-read.jsonl: a tool call and its result', () => {
  const s = feed('tool-read.jsonl')
  it('records the tool_use with its input and the final text', () => {
    expect(s.toolCalls.map((t) => t.name)).toEqual(['Read'])
    expect(JSON.stringify(s.toolCalls[0].input)).toContain('secret-number.txt')
    const r = summaryToRunResult(s, CTX)
    expect(r.text).toBe('marveen-probe-42')
    expect(r.blocked).toBe(false)
    expect(r.usage?.inputTokens).toBe(18)
    expect(r.usage?.outputTokens).toBe(174)
  })
})

describe('resume.jsonl: --resume keeps the session id', () => {
  it('same session id as the tool-read run', () => {
    const s = feed('resume.jsonl')
    expect(s.sessionId).toBe('981a3311-0fc4-4952-a250-251ed0a28620')
    expect(summaryToRunResult(s, CTX).text).toBe('42')
  })
})

describe('stream-input-two-turns.jsonl: --input-format stream-json', () => {
  const s = feed('stream-input-two-turns.jsonl')
  it('accumulates one result per turn; RunResult reflects the last', () => {
    expect(s.results).toHaveLength(2)
    expect(s.results.map((r) => r.result)).toEqual(['A', 'B'])
    expect(summaryToRunResult(s, CTX).text).toBe('B')
    expect(s.textParts).toEqual(['A', 'B'])
  })
})

describe('auth-failed.jsonl: dead login', () => {
  const s = feed('auth-failed.jsonl')
  it('is blocked (text=null) with an explanatory reason, never surfaced as content', () => {
    const r = summaryToRunResult(s, CTX)
    expect(r.text).toBeNull()
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/is_error=true/)
    expect(r.reason).toMatch(/authentication_failed/)
    expect(r.reason).toMatch(/Not logged in/)
  })
  it('streamShowsAuthFailure flags it; the healthy stream is not flagged', () => {
    expect(streamShowsAuthFailure(s)).toBe(true)
    expect(streamShowsAuthFailure(feed('text-ok.jsonl'))).toBe(false)
  })
  it('the <synthetic> model placeholder is not mistaken for a real model', () => {
    expect(s.model).toBeNull()
    expect(s.apiErrors).toEqual(['authentication_failed'])
  })
})

describe('summaryToRunResult without any result event', () => {
  it('reports the exit code / stderr instead of pretending success', () => {
    const acc = new ClaudeStreamAccumulator()
    acc.push('{"type":"system","subtype":"init","session_id":"s1"}')
    acc.push('garbage line')
    const r = summaryToRunResult(acc.summary(), { ...CTX, exitCode: 1, stderrTail: 'boom' })
    expect(r.blocked).toBe(true)
    expect(r.text).toBeNull()
    expect(r.reason).toContain('no result event')
    expect(r.reason).toContain('exit=1')
    expect(r.reason).toContain('stderr=boom')
    expect(r.reason).toContain('malformedLines=1')
    expect(r.sessionRef).toBe('s1')
  })
})

describe('usageFromResult', () => {
  it('prefers the modelUsage key over the configured model, tolerates missing usage', () => {
    const u = usageFromResult({ type: 'result', modelUsage: { 'claude-sonnet-5': {} } }, { ...CTX, timestamp: 5 })
    expect(u.model).toBe('claude-sonnet-5')
    expect(u.inputTokens).toBe(0)
    expect(u.costUsd).toBeUndefined()
  })
})
