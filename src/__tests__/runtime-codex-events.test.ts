import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CodexStreamAccumulator, parseCodexLine, codexSummaryToRunResult, codexShowsAuthFailure, codexItemToolName, usageFromCodex,
} from '../runtime/codex-events.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-cli')
const CTX = { runtime: 'codex-cli' as const, provider: 'openai' as const, model: 'gpt-5.6-sol' }

function feed(name: string, onText?: (t: string) => void) {
  const acc = new CodexStreamAccumulator({ onText })
  for (const line of readFileSync(join(FIX, name), 'utf-8').split('\n')) acc.push(line)
  return acc.summary()
}

describe('parseCodexLine', () => {
  it('null for blank / non-JSON / untyped', () => {
    expect(parseCodexLine('')).toBeNull()
    expect(parseCodexLine('Reading additional input from stdin...')).toBeNull()
    expect(parseCodexLine('{"x":1}')).toBeNull()
  })
})

describe('text-ok.jsonl (doc-derived)', () => {
  const s = feed('text-ok.jsonl')
  it('thread id, final agent message, tool call mapped to Bash, usage', () => {
    expect(s.threadId).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53')
    expect(s.messages).toEqual(['Repo contains docs, sdk, and examples directories.'])
    expect(s.reasoning).toEqual(['Listing the repository root.'])
    expect(s.toolCalls).toEqual([{ name: 'Bash', input: { command: 'bash -lc ls' }, ok: true }])
    expect(s.turnsCompleted).toBe(1)
    expect(s.turnFailed).toBeNull()
  })
  it('folds into a usable RunResult; cached tokens map to cacheRead', () => {
    const r = codexSummaryToRunResult(s, { ...CTX, timestamp: 7, exitCode: 0 })
    expect(r.blocked).toBe(false)
    expect(r.text).toBe('Repo contains docs, sdk, and examples directories.')
    expect(r.sessionRef).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53')
    expect(r.usage).toMatchObject({ inputTokens: 24763, cacheReadTokens: 24448, outputTokens: 122, thinkingTokens: 0, runtime: 'codex-cli', provider: 'openai', timestamp: 7 })
    expect(r.usage?.costUsd).toBeUndefined()
  })
  it('streams agent_message text to onText', () => {
    const chunks: string[] = []
    feed('text-ok.jsonl', (t) => chunks.push(t))
    expect(chunks).toHaveLength(1)
  })
  it('an item.started followed by item.completed with the same id counts once', () => {
    expect(s.toolCalls).toHaveLength(1)
  })
})

describe('auth-failed.jsonl (recorded live, exit code was 0)', () => {
  const s = feed('auth-failed.jsonl')
  it('is blocked with turn.failed + 401 detail, never returns text', () => {
    const r = codexSummaryToRunResult(s, { ...CTX, exitCode: 0 })
    expect(r.text).toBeNull()
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/turn\.failed=.*401 Unauthorized/)
    expect(s.turnsCompleted).toBe(0)
    expect(s.errors.length).toBeGreaterThan(5)
  })
  it('is recognised as an auth failure', () => {
    expect(codexShowsAuthFailure(s)).toBe(true)
    expect(codexShowsAuthFailure(feed('text-ok.jsonl'))).toBe(false)
  })
})

describe('edge cases', () => {
  it('no events at all -> blocked with exit/stderr detail', () => {
    const acc = new CodexStreamAccumulator()
    acc.push('not json')
    const r = codexSummaryToRunResult(acc.summary(), { ...CTX, exitCode: 127, stderrTail: 'codex: not found' })
    expect(r.blocked).toBe(true)
    expect(r.reason).toContain('no turn.completed')
    expect(r.reason).toContain('exit=127')
    expect(r.reason).toContain('stderr=codex: not found')
    expect(r.reason).toContain('malformedLines=1')
  })
  it('turn completed without an agent message but WITH token usage -> not blocked, text null, reason explains', () => {
    const acc = new CodexStreamAccumulator()
    acc.push('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')
    const r = codexSummaryToRunResult(acc.summary(), CTX)
    expect(r.blocked).toBe(false)
    expect(r.text).toBeNull()
    expect(r.reason).toMatch(/without an agent_message/)
  })
  it('the bypass-hook-trust notice is a warning, not an error; an empty zero-usage turn is still blocked (recorded live)', () => {
    const acc = new CodexStreamAccumulator()
    acc.push('{"type":"thread.started","thread_id":"01a0c7a5-e673-7783-a90b-2304032acfa7"}')
    acc.push('{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation."}}')
    acc.push('{"type":"turn.started"}')
    acc.push('{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}')
    const s = acc.summary()
    expect(s.warnings).toHaveLength(1)
    expect(s.errors).toEqual([])
    const r = codexSummaryToRunResult(s, CTX)
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/zero token usage/)
    expect(r.reason).toMatch(/warnings=1/)
    expect(codexShowsAuthFailure(s)).toBe(false)
  })
  it('turn completed with errors and NO agent message is a silent failure -> blocked (observed live: 401 retries then turn.completed)', () => {
    const acc = new CodexStreamAccumulator()
    acc.push('{"type":"thread.started","thread_id":"t1"}')
    acc.push('{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer"}')
    acc.push('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}')
    const r = codexSummaryToRunResult(acc.summary(), CTX)
    expect(r.blocked).toBe(true)
    expect(r.text).toBeNull()
    expect(r.reason).toMatch(/without agent_message but with errors/)
    expect(r.reason).toMatch(/401/)
    expect(codexShowsAuthFailure(acc.summary())).toBe(true)
  })
  it('item tool-name mapping', () => {
    expect(codexItemToolName({ type: 'file_change' })).toBe('Edit')
    expect(codexItemToolName({ type: 'mcp_tool_call', server: 'marveen-channel', tool: 'reply' })).toBe('mcp__marveen-channel__reply')
    expect(codexItemToolName({ type: 'web_search' })).toBe('WebSearch')
    expect(codexItemToolName({ type: 'todo_list' })).toBeNull()
  })
  it('usageFromCodex tolerates null usage', () => {
    const u = usageFromCodex(null, { ...CTX, timestamp: 1, threadId: 't' })
    expect(u).toMatchObject({ inputTokens: 0, outputTokens: 0, sessionRef: 't' })
  })
})
