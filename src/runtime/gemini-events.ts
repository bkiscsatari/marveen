// Google Gemini CLI `--output-format stream-json` parser (Phase 3).
//
// Event shapes taken from the installed CLI's source (gemini-cli 0.60.0,
// packages/cli nonInteractiveCli + packages/core/output/stream-json-formatter,
// read 2026-09-22) -- the docs only list the event names:
//
//   {"type":"init","timestamp","session_id","model"}
//   {"type":"message","timestamp","role":"user"|"assistant","content":string,"delta"?:true}
//   {"type":"tool_use","timestamp","tool_name","tool_id","parameters"}
//   {"type":"tool_result","timestamp","tool_id","status":"success"|"error","output","error"?:{type,message}}
//   {"type":"error","timestamp","severity":"error"|"warning","message"}
//   {"type":"result","timestamp","status":"success"|"error","stats":{total_tokens,input_tokens,output_tokens,cached,input,duration_ms,tool_calls,models:{<model>:{...}}}}
//
// Exit codes (docs): 0 ok, 1 error, 42 input error, 53 turn limit. Pure.

import type { ProviderKind, RunResult, RuntimeKind, ToolCallRecord, UsageRecord } from './types.js'

export interface GeminiStats {
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  cached?: number
  input?: number
  duration_ms?: number
  tool_calls?: number
  models?: Record<string, { total_tokens?: number; input_tokens?: number; output_tokens?: number; cached?: number }>
}

export type GeminiEvent =
  | { type: 'init'; session_id?: string; model?: string; timestamp?: string }
  | { type: 'message'; role?: string; content?: string; delta?: boolean; timestamp?: string }
  | { type: 'tool_use'; tool_name?: string; tool_id?: string; parameters?: unknown; timestamp?: string }
  | { type: 'tool_result'; tool_id?: string; status?: string; output?: string; error?: { type?: string; message?: string }; timestamp?: string }
  | { type: 'error'; severity?: string; message?: string; timestamp?: string }
  | { type: 'result'; status?: string; stats?: GeminiStats; timestamp?: string }
  | { type: string; [k: string]: unknown }

export function parseGeminiLine(line: string): GeminiEvent | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && typeof o.type === 'string' ? (o as GeminiEvent) : null
  } catch {
    return null
  }
}

/** Gemini built-in tool names -> the Claude names the governance hooks match on. */
export const GEMINI_TO_CLAUDE_TOOL: Record<string, string> = {
  run_shell_command: 'Bash',
  write_file: 'Write',
  replace: 'Edit',
  read_file: 'Read',
  read_many_files: 'Read',
  web_fetch: 'WebFetch',
  google_web_search: 'WebSearch',
  glob: 'Glob',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  list_directory: 'Bash',
  save_memory: 'Write',
}

export function geminiToolName(name: string | undefined): string {
  if (!name) return 'unknown'
  return GEMINI_TO_CLAUDE_TOOL[name] ?? name
}

export interface GeminiSummary {
  sessionId: string | null
  model: string | null
  /** Assistant text, concatenated from delta chunks in arrival order. */
  text: string
  toolCalls: ToolCallRecord[]
  stats: GeminiStats | null
  resultStatus: 'success' | 'error' | null
  errors: string[]
  warnings: string[]
  malformedLines: number
}

export class GeminiStreamAccumulator {
  private s: GeminiSummary = { sessionId: null, model: null, text: '', toolCalls: [], stats: null, resultStatus: null, errors: [], warnings: [], malformedLines: 0 }
  private pendingTools = new Map<string, ToolCallRecord>()
  private onText?: (chunk: string) => void
  constructor(opts: { onText?: (chunk: string) => void } = {}) { this.onText = opts.onText }

  push(line: string): GeminiEvent | null {
    const ev = parseGeminiLine(line)
    if (!ev) { if (line.trim()) this.s.malformedLines++; return null }
    this.consume(ev)
    return ev
  }

  consume(ev: GeminiEvent): void {
    const s = this.s
    switch (ev.type) {
      case 'init': {
        const e = ev as Extract<GeminiEvent, { type: 'init' }>
        if (typeof e.session_id === 'string') s.sessionId = e.session_id
        if (typeof e.model === 'string') s.model = e.model
        break
      }
      case 'message': {
        const e = ev as Extract<GeminiEvent, { type: 'message' }>
        if (e.role === 'assistant' && typeof e.content === 'string') { s.text += e.content; this.onText?.(e.content) }
        break
      }
      case 'tool_use': {
        const e = ev as Extract<GeminiEvent, { type: 'tool_use' }>
        const rec: ToolCallRecord = { name: geminiToolName(e.tool_name), input: e.parameters }
        s.toolCalls.push(rec)
        if (e.tool_id) this.pendingTools.set(e.tool_id, rec)
        break
      }
      case 'tool_result': {
        const e = ev as Extract<GeminiEvent, { type: 'tool_result' }>
        const rec = e.tool_id ? this.pendingTools.get(e.tool_id) : undefined
        if (rec) rec.ok = e.status !== 'error'
        break
      }
      case 'error': {
        const e = ev as Extract<GeminiEvent, { type: 'error' }>
        const msg = e.message ?? 'error'
        if (e.severity === 'warning') s.warnings.push(msg); else s.errors.push(msg)
        break
      }
      case 'result': {
        const e = ev as Extract<GeminiEvent, { type: 'result' }>
        s.resultStatus = e.status === 'error' ? 'error' : 'success'
        s.stats = e.stats ?? s.stats
        break
      }
      default: break
    }
  }

  summary(): GeminiSummary { return this.s }
}

export function usageFromGemini(st: GeminiStats | null, ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp: number; sessionId?: string | null }): UsageRecord {
  const modelFromStats = st?.models && typeof st.models === 'object' ? Object.keys(st.models)[0] : undefined
  return {
    inputTokens: Number(st?.input_tokens) || 0,
    outputTokens: Number(st?.output_tokens) || 0,
    cacheReadTokens: Number(st?.cached) || 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
    model: modelFromStats ?? ctx.model,
    provider: ctx.provider,
    runtime: ctx.runtime,
    costUsd: undefined,
    timestamp: ctx.timestamp,
    sessionRef: ctx.sessionId ?? undefined,
  }
}

export function geminiShowsAuthFailure(s: GeminiSummary, stderrTail = ''): boolean {
  const all = [...s.errors, stderrTail]
  return all.some((m) => /Please set an Auth method|GEMINI_API_KEY|FatalAuthenticationError|401|UNAUTHENTICATED|not authenticated|login/i.test(m))
}

export function geminiSummaryToRunResult(
  s: GeminiSummary,
  ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp?: number; exitCode?: number | null; stderrTail?: string },
): RunResult {
  const usage = usageFromGemini(s.stats, { ...ctx, timestamp: ctx.timestamp ?? Date.now(), sessionId: s.sessionId })
  const text = s.text.trim() ? s.text : null
  const exitBad = ctx.exitCode !== undefined && ctx.exitCode !== null && ctx.exitCode !== 0
  if (s.resultStatus !== 'success' || exitBad || (text === null && s.errors.length > 0)) {
    const bits: string[] = []
    if (s.resultStatus === 'error') bits.push('result.status=error')
    else if (s.resultStatus === null) bits.push('no result event')
    if (exitBad) bits.push(`exit=${ctx.exitCode}` + (ctx.exitCode === 42 ? ' (input error)' : ctx.exitCode === 53 ? ' (turn limit)' : ''))
    if (s.errors.length) bits.push(`errors=${s.errors.slice(-2).join('; ').slice(0, 300)}`)
    if (ctx.stderrTail?.trim()) bits.push(`stderr=${ctx.stderrTail.trim().slice(-300)}`)
    if (s.malformedLines) bits.push(`malformedLines=${s.malformedLines}`)
    return { text: null, blocked: true, reason: bits.join(' '), usage, sessionRef: s.sessionId ?? undefined, toolCalls: s.toolCalls }
  }
  return { text, blocked: false, reason: text === null ? 'result success without assistant text' : undefined, usage, sessionRef: s.sessionId ?? undefined, toolCalls: s.toolCalls }
}
