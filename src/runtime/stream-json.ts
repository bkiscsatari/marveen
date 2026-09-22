// Claude Code `--output-format stream-json` parser (Phase 1).
//
// Pure: no I/O, no process. The claude-headless adapter feeds it stdout lines;
// the tests feed it recorded fixtures (src/__tests__/fixtures/claude-headless/,
// captured live on 2026-09-22 from Claude Code 2.1.278). Event shapes seen:
//
//   {"type":"system","subtype":"init","session_id","model","tools",...}
//   {"type":"assistant","message":{"model","id","content":[thinking|text|tool_use],"usage":{...}},"error"?:"authentication_failed"}
//   {"type":"user","message":{"content":[tool_result]}}            (tool results echoed back)
//   {"type":"system","subtype":"thinking_tokens",...}                 (ignored)
//   {"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization"},"seven_day":{...}}}}
//   {"type":"result","subtype":"success","is_error","result","session_id","total_cost_usd","usage","modelUsage",...}
//
// With --input-format stream-json several `result` events arrive in one
// process (one per user turn); the accumulator keeps them all and the
// RunResult reflects the LAST one.

import { classifyAgentResult } from '../agent.js'
import type { ProviderKind, RunResult, RuntimeKind, ToolCallRecord, UsageRecord } from './types.js'

export interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number } | null
}

export interface ClaudeResultEvent {
  type: 'result'
  subtype?: string
  is_error?: boolean
  api_error_status?: number | null
  result?: unknown
  errors?: string[]
  stop_reason?: string | null
  session_id?: string
  total_cost_usd?: number
  usage?: ClaudeUsage
  modelUsage?: Record<string, unknown>
  num_turns?: number
  terminal_reason?: string
}

export interface RateLimitWindow { utilization?: number; resetsAt?: number }
export interface RateLimitInfo {
  status?: string
  rateLimitType?: string
  resetsAt?: number
  unifiedWindows?: { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow; [k: string]: RateLimitWindow | undefined }
}

export type ClaudeStreamEvent =
  | { type: 'system'; subtype?: string; session_id?: string; model?: string; [k: string]: unknown }
  | { type: 'assistant'; message?: { model?: string; id?: string; content?: unknown[]; usage?: ClaudeUsage }; session_id?: string; error?: string; [k: string]: unknown }
  | { type: 'user'; [k: string]: unknown }
  | { type: 'rate_limit_event'; rate_limit_info?: RateLimitInfo; [k: string]: unknown }
  | ClaudeResultEvent
  | { type: string; [k: string]: unknown }

/** One line -> one event, or null for blank / non-JSON lines (never throws). */
export function parseStreamLine(line: string): ClaudeStreamEvent | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && typeof o.type === 'string' ? (o as ClaudeStreamEvent) : null
  } catch {
    return null
  }
}

export interface ClaudeStreamSummary {
  sessionId: string | null
  /** Model that actually answered (from assistant events; "<synthetic>" is skipped). */
  model: string | null
  /** Assistant text blocks in arrival order (the visible reply, sans thinking). */
  textParts: string[]
  toolCalls: ToolCallRecord[]
  results: ClaudeResultEvent[]
  rateLimit: RateLimitInfo | null
  /** `error` fields on assistant events (e.g. "authentication_failed"). */
  apiErrors: string[]
  /** Lines that were not valid JSON (stderr noise, partial writes). */
  malformedLines: number
}

export class ClaudeStreamAccumulator {
  private s: ClaudeStreamSummary = {
    sessionId: null, model: null, textParts: [], toolCalls: [], results: [],
    rateLimit: null, apiErrors: [], malformedLines: 0,
  }
  private onText?: (chunk: string) => void

  constructor(opts: { onText?: (chunk: string) => void } = {}) {
    this.onText = opts.onText
  }

  push(line: string): ClaudeStreamEvent | null {
    const ev = parseStreamLine(line)
    if (!ev) {
      if (line.trim()) this.s.malformedLines++
      return null
    }
    this.consume(ev)
    return ev
  }

  consume(ev: ClaudeStreamEvent): void {
    const s = this.s
    if (typeof (ev as { session_id?: unknown }).session_id === 'string') {
      s.sessionId = (ev as { session_id: string }).session_id
    }
    switch (ev.type) {
      case 'assistant': {
        const e = ev as Extract<ClaudeStreamEvent, { type: 'assistant' }>
        if (typeof e.error === 'string') s.apiErrors.push(e.error)
        const model = e.message?.model
        if (typeof model === 'string' && model && !model.startsWith('<')) s.model = model
        const content = Array.isArray(e.message?.content) ? e.message!.content! : []
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: string; text?: string; name?: string; input?: unknown }
          if (b.type === 'text' && typeof b.text === 'string') {
            s.textParts.push(b.text)
            this.onText?.(b.text)
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            s.toolCalls.push({ name: b.name, input: b.input })
          }
        }
        break
      }
      case 'rate_limit_event': {
        const e = ev as Extract<ClaudeStreamEvent, { type: 'rate_limit_event' }>
        if (e.rate_limit_info && typeof e.rate_limit_info === 'object') s.rateLimit = e.rate_limit_info
        break
      }
      case 'result':
        s.results.push(ev as ClaudeResultEvent)
        break
      default:
        break
    }
  }

  summary(): ClaudeStreamSummary {
    return this.s
  }
}

/** Usage record from a result event (the per-turn totals Claude reports). */
export function usageFromResult(
  r: ClaudeResultEvent,
  ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp: number },
): UsageRecord {
  const u = r.usage ?? {}
  const modelFromUsage = r.modelUsage && typeof r.modelUsage === 'object' ? Object.keys(r.modelUsage)[0] : undefined
  return {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
    cacheCreationTokens: Number(u.cache_creation_input_tokens) || 0,
    thinkingTokens: Number(u.output_tokens_details?.thinking_tokens) || 0,
    model: modelFromUsage ?? ctx.model,
    provider: ctx.provider,
    runtime: ctx.runtime,
    costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
    timestamp: ctx.timestamp,
    sessionRef: r.session_id,
  }
}

/**
 * Collapse a finished stream into the runtime-neutral RunResult. Reuses
 * classifyAgentResult (src/agent.ts) so a policy block / API error / auth
 * failure yields text=null exactly as the SDK path always did.
 */
export function summaryToRunResult(
  s: ClaudeStreamSummary,
  ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp?: number; exitCode?: number | null; stderrTail?: string },
): RunResult {
  const last = s.results[s.results.length - 1]
  if (!last) {
    const bits = [`no result event`]
    if (ctx.exitCode !== undefined && ctx.exitCode !== null) bits.push(`exit=${ctx.exitCode}`)
    if (s.apiErrors.length) bits.push(`apiErrors=${s.apiErrors.join(',')}`)
    if (ctx.stderrTail) bits.push(`stderr=${ctx.stderrTail.slice(0, 300)}`)
    if (s.malformedLines) bits.push(`malformedLines=${s.malformedLines}`)
    return { text: null, blocked: true, reason: bits.join(' '), sessionRef: s.sessionId ?? undefined, toolCalls: s.toolCalls }
  }
  const c = classifyAgentResult(last)
  const usage = usageFromResult(last, { ...ctx, model: s.model ?? ctx.model, timestamp: ctx.timestamp ?? Date.now() })
  const reasonBits: string[] = []
  if (c.blocked && c.reason) reasonBits.push(c.reason)
  if (c.blocked && s.apiErrors.length) reasonBits.push(`apiErrors=${s.apiErrors.join(',')}`)
  return {
    text: c.text,
    blocked: c.blocked,
    reason: reasonBits.length ? reasonBits.join(' ') : undefined,
    usage,
    sessionRef: last.session_id ?? s.sessionId ?? undefined,
    toolCalls: s.toolCalls,
  }
}

/** True when the stream shows a dead subscription login (for the 'auth' state). */
export function streamShowsAuthFailure(s: ClaudeStreamSummary): boolean {
  if (s.apiErrors.some((e) => /auth/i.test(e))) return true
  const last = s.results[s.results.length - 1]
  return !!last && last.is_error === true && typeof last.result === 'string' && /Not logged in|Please run \/login|401/i.test(last.result)
}
