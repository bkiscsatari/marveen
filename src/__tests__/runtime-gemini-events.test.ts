import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeminiStreamAccumulator, geminiSummaryToRunResult, geminiShowsAuthFailure, geminiToolName, parseGeminiLine } from '../runtime/gemini-events.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gemini-cli')
const CTX = { runtime: 'gemini-cli' as const, provider: 'google' as const, model: 'gemini-2.5-flash' }

function feed(name: string, onText?: (t: string) => void) {
  const acc = new GeminiStreamAccumulator({ onText })
  for (const line of readFileSync(join(FIX, name), 'utf-8').split('\n')) acc.push(line)
  return acc.summary()
}

describe('text-ok.jsonl (source-derived)', () => {
  const s = feed('text-ok.jsonl')
  it('session, model, concatenated assistant deltas, tool call mapped to Read with ok=true', () => {
    expect(s.sessionId).toBe('6f2c1a1e-1111-4222-8333-444455556666')
    expect(s.model).toBe('gemini-2.5-flash')
    expect(s.text).toBe('marveen-probe-42')
    expect(s.toolCalls).toEqual([{ name: 'Read', input: { absolute_path: '/tmp/x/secret-number.txt' }, ok: true }])
    expect(s.resultStatus).toBe('success')
  })
  it('RunResult with usage from stats (cached -> cacheRead, model from stats.models)', () => {
    const r = geminiSummaryToRunResult(s, { ...CTX, timestamp: 3, exitCode: 0 })
    expect(r.blocked).toBe(false)
    expect(r.text).toBe('marveen-probe-42')
    expect(r.usage).toMatchObject({ inputTokens: 1100, outputTokens: 134, cacheReadTokens: 900, model: 'gemini-2.5-flash', runtime: 'gemini-cli', provider: 'google', timestamp: 3 })
    expect(r.sessionRef).toBe('6f2c1a1e-1111-4222-8333-444455556666')
  })
  it('streams deltas to onText', () => {
    const chunks: string[] = []
    feed('text-ok.jsonl', (t) => chunks.push(t))
    expect(chunks).toEqual(['marveen-', 'probe-42'])
  })
})

describe('failure shapes', () => {
  it('auth-less run: no stdout, exit 0, stderr hint -> blocked + auth detected', () => {
    const acc = new GeminiStreamAccumulator()
    const stderr = 'Please set an Auth method in your /home/x/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA'
    const r = geminiSummaryToRunResult(acc.summary(), { ...CTX, exitCode: 0, stderrTail: stderr })
    expect(r.blocked).toBe(true)
    expect(r.text).toBeNull()
    expect(r.reason).toContain('no result event')
    expect(r.reason).toContain('Auth method')
    expect(geminiShowsAuthFailure(acc.summary(), stderr)).toBe(true)
  })
  it('result.status=error with an error event -> blocked with the message', () => {
    const acc = new GeminiStreamAccumulator()
    acc.push('{"type":"init","session_id":"s","model":"m"}')
    acc.push('{"type":"error","severity":"error","message":"RESOURCE_EXHAUSTED: quota"}')
    acc.push('{"type":"result","status":"error","stats":{"input_tokens":0,"output_tokens":0}}')
    const r = geminiSummaryToRunResult(acc.summary(), { ...CTX, exitCode: 1 })
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/result\.status=error/)
    expect(r.reason).toMatch(/exit=1/)
    expect(r.reason).toMatch(/RESOURCE_EXHAUSTED/)
  })
  it('exit 42 / 53 are labelled', () => {
    const acc = new GeminiStreamAccumulator()
    expect(geminiSummaryToRunResult(acc.summary(), { ...CTX, exitCode: 42 }).reason).toContain('(input error)')
    expect(geminiSummaryToRunResult(acc.summary(), { ...CTX, exitCode: 53 }).reason).toContain('(turn limit)')
  })
  it('warnings do not block a successful result', () => {
    const acc = new GeminiStreamAccumulator()
    acc.push('{"type":"error","severity":"warning","message":"Agent execution blocked: minor"}')
    acc.push('{"type":"message","role":"assistant","content":"ok"}')
    acc.push('{"type":"result","status":"success","stats":{"input_tokens":1,"output_tokens":1}}')
    const r = geminiSummaryToRunResult(acc.summary(), CTX)
    expect(r.blocked).toBe(false)
    expect(acc.summary().warnings).toHaveLength(1)
  })
})

describe('helpers', () => {
  it('parseGeminiLine ignores junk', () => {
    expect(parseGeminiLine('')).toBeNull()
    expect(parseGeminiLine('Loaded cached credentials.')).toBeNull()
  })
  it('geminiToolName maps built-ins, passes MCP tools through', () => {
    expect(geminiToolName('run_shell_command')).toBe('Bash')
    expect(geminiToolName('web_fetch')).toBe('WebFetch')
    expect(geminiToolName('reply')).toBe('reply')
    expect(geminiToolName(undefined)).toBe('unknown')
  })
})
