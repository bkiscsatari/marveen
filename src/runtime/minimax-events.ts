// MiniMax Code (`mcode exec --output-format stream-json`) JSONL parser (Phase 7).
//
// Shapes read from the installed CLI (@minimax-ai/code 0.5.1,
// chunks/run-exec-command-*.js "Exec event projector", 2026-09-22). Every
// event carries {schemaVersion:1, sequence, timestampMs, runId, sessionId,
// turnId, type} plus:
//   exec.started | session.started | session.resumed | turn.started
//   item.started | item.updated | item.completed   item:{id, type:"reasoning"|"agent_message"|"tool_call", content?|contentDelta?, toolCall?}
//   turn.completed {model?, usage?, usageSource?, usageIncomplete?, durationMs}
//   turn.failed    {status, error?, durationMs}
//   exec.completed {result: ExecResult}
// ExecResult (also the `--output-format json` document):
//   {schemaVersion:1, type:"exec.result", runId, sessionId, turnId, status:"succeeded"|"failed"|…, output?, error?, model?, usage?, durationMs}
// Exit codes observed: 0 ok, 3 "Sign in to MiniMax" (auth). Pure.

import type { ProviderKind, RunResult, RuntimeKind, ToolCallRecord, UsageRecord } from './types.js'

// Recorded live (2026-09-22, subscription): usage = {inputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens, totalTokens}; the harness-internal shape
// {input, output, cacheRead, cacheWrite} is kept as a fallback.
export interface MinimaxUsage {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number
  cost?: { total?: number; input?: number; output?: number }
}

// Recorded live: toolCall = {id, name, status:<number>, input:{...}}; status
// climbs 4 -> 5 -> 1 (running) -> 2 (completed). `arguments` kept as fallback.
export interface MinimaxItem {
  id?: string
  type?: 'reasoning' | 'agent_message' | 'tool_call' | string
  content?: string
  contentDelta?: string
  toolCall?: { id?: string; name?: string; input?: unknown; arguments?: unknown; status?: string | number; [k: string]: unknown }
}

export function toolCallOk(status: string | number | undefined): boolean | undefined {
  if (status === undefined || status === null || status === '') return undefined
  const st = String(status).toLowerCase()
  if (st === '2' || /complet|succ|done/.test(st)) return true
  if (st === '3' || /fail|error|cancel|reject/.test(st)) return false
  return undefined
}

export interface MinimaxExecResult {
  type?: 'exec.result'
  runId?: string; sessionId?: string; turnId?: string
  status?: string
  output?: unknown
  error?: { category?: string; code?: string; message?: string }
  model?: { id?: string; provider?: string; name?: string } | string
  usage?: MinimaxUsage
  durationMs?: number
}

export type MinimaxEvent = { type: string; sessionId?: string; runId?: string; turnId?: string; item?: MinimaxItem; result?: MinimaxExecResult; usage?: MinimaxUsage; model?: MinimaxExecResult['model']; status?: string; error?: { message?: string; code?: string }; [k: string]: unknown }

export function parseMinimaxLine(line: string): MinimaxEvent | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && typeof o.type === 'string' ? (o as MinimaxEvent) : null
  } catch { return null }
}

/** MiniMax built-in tool names -> Claude names the governance hooks match on. */
export const MINIMAX_TO_CLAUDE_TOOL: Record<string, string> = {
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', multi_edit: 'MultiEdit', grep: 'Grep', glob: 'Glob', ls: 'Bash',
  web_fetch: 'WebFetch', web_search: 'WebSearch', task: 'Task', skill: 'Skill',
}
export function minimaxToolName(name: string | undefined): string {
  if (!name) return 'unknown'
  return MINIMAX_TO_CLAUDE_TOOL[name] ?? name
}

export interface MinimaxSummary {
  sessionId: string | null
  runId: string | null
  model: string | null
  /** Completed agent_message texts, in order; deltas are folded per item id. */
  messages: string[]
  reasoning: string[]
  toolCalls: ToolCallRecord[]
  usage: MinimaxUsage | null
  result: MinimaxExecResult | null
  turnCompleted: boolean
  turnFailed: string | null
  errors: string[]
  malformedLines: number
}

export class MinimaxStreamAccumulator {
  private s: MinimaxSummary = { sessionId: null, runId: null, model: null, messages: [], reasoning: [], toolCalls: [], usage: null, result: null, turnCompleted: false, turnFailed: null, errors: [], malformedLines: 0 }
  private partial = new Map<string, string>()
  private done = new Set<string>()
  private onText?: (chunk: string) => void
  constructor(opts: { onText?: (chunk: string) => void } = {}) { this.onText = opts.onText }

  push(line: string): MinimaxEvent | null {
    const ev = parseMinimaxLine(line)
    if (!ev) { if (line.trim()) this.s.malformedLines++; return null }
    this.consume(ev)
    return ev
  }

  consume(ev: MinimaxEvent): void {
    const s = this.s
    if (typeof ev.sessionId === 'string') s.sessionId = ev.sessionId
    if (typeof ev.runId === 'string') s.runId = ev.runId
    switch (ev.type) {
      case 'item.started':
      case 'item.updated': {
        const it = ev.item
        if (it?.type === 'agent_message' && typeof it.contentDelta === 'string' && it.id) {
          this.partial.set(it.id, (this.partial.get(it.id) ?? '') + it.contentDelta)
          this.onText?.(it.contentDelta)
        }
        break
      }
      case 'item.completed': {
        const it = ev.item
        if (!it) break
        const key = it.id ?? `${it.type}:${s.messages.length}`
        if (this.done.has(key)) break
        this.done.add(key)
        if (it.type === 'agent_message') {
          const text = typeof it.content === 'string' ? it.content : (this.partial.get(key) ?? '')
          if (text) { s.messages.push(text); if (typeof it.content === 'string' && !this.partial.has(key)) this.onText?.(text) }
        } else if (it.type === 'reasoning') {
          const text = typeof it.content === 'string' ? it.content : ''
          if (text) s.reasoning.push(text)
        } else if (it.type === 'tool_call') {
          const tc = it.toolCall ?? {}
          s.toolCalls.push({ name: minimaxToolName(tc.name), input: tc.input ?? tc.arguments, ok: toolCallOk(tc.status) })
        }
        break
      }
      case 'turn.completed':
        s.turnCompleted = true
        if (ev.usage) s.usage = ev.usage
        if (ev.model) s.model = typeof ev.model === 'string' ? ev.model : ev.model.id ?? ev.model.name ?? null
        break
      case 'turn.failed':
        s.turnFailed = ev.error?.message ?? ev.status ?? 'turn failed'
        break
      case 'exec.completed':
        if (ev.result) this.applyResult(ev.result)
        break
      case 'exec.result':
        this.applyResult(ev as unknown as MinimaxExecResult)
        break
      case 'error':
      case 'session.error':
        s.errors.push(ev.error?.message ?? String((ev as { message?: unknown }).message ?? 'error'))
        break
      default: break
    }
  }

  applyResult(r: MinimaxExecResult): void {
    const s = this.s
    s.result = r
    if (typeof r.sessionId === 'string') s.sessionId = r.sessionId
    if (r.usage) s.usage = r.usage
    if (r.model) s.model = typeof r.model === 'string' ? r.model : r.model.id ?? r.model.name ?? s.model
    if (r.status === 'succeeded') s.turnCompleted = true
    else if (r.status && !s.turnFailed) s.turnFailed = r.error?.message ?? r.status
    if (typeof r.output === 'string' && r.output.trim() && !s.messages.length) s.messages.push(r.output)
  }

  summary(): MinimaxSummary { return this.s }
}

export function usageFromMinimax(u: MinimaxUsage | null, ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp: number; sessionId?: string | null }): UsageRecord {
  return {
    inputTokens: Number(u?.inputTokens ?? u?.input) || 0,
    outputTokens: Number(u?.outputTokens ?? u?.output) || 0,
    cacheReadTokens: Number(u?.cacheReadTokens ?? u?.cacheRead) || 0,
    cacheCreationTokens: Number(u?.cacheWriteTokens ?? u?.cacheWrite) || 0,
    thinkingTokens: 0,
    model: ctx.model, provider: ctx.provider, runtime: ctx.runtime,
    costUsd: typeof u?.cost?.total === 'number' && u.cost.total > 0 ? u.cost.total : undefined,
    timestamp: ctx.timestamp, sessionRef: ctx.sessionId ?? undefined,
  }
}

export function minimaxShowsAuthFailure(s: MinimaxSummary, stderrTail = '', exitCode?: number | null): boolean {
  if (exitCode === 3) return true
  return [...s.errors, s.turnFailed ?? '', stderrTail].some((m) => /Sign in to MiniMax|mcode login|not signed in|unauthorized|401/i.test(m))
}

export function minimaxSummaryToRunResult(
  s: MinimaxSummary,
  ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp?: number; exitCode?: number | null; stderrTail?: string },
): RunResult {
  const usage = usageFromMinimax(s.usage, { ...ctx, model: s.model ?? ctx.model, timestamp: ctx.timestamp ?? Date.now(), sessionId: s.sessionId })
  const last = s.messages[s.messages.length - 1] ?? null
  const exitBad = ctx.exitCode !== undefined && ctx.exitCode !== null && ctx.exitCode !== 0
  if (s.turnFailed !== null || !s.turnCompleted || exitBad) {
    const bits: string[] = []
    if (s.turnFailed !== null) bits.push(`turn.failed=${s.turnFailed.slice(0, 300)}`)
    else if (!s.turnCompleted) bits.push('no turn.completed / exec.result succeeded')
    if (exitBad) bits.push(`exit=${ctx.exitCode}${ctx.exitCode === 3 ? ' (auth: run `mcode login`)' : ''}`)
    if (s.errors.length) bits.push(`errors=${s.errors.slice(-2).join('; ').slice(0, 300)}`)
    if (ctx.stderrTail?.trim()) bits.push(`stderr=${ctx.stderrTail.trim().slice(-300)}`)
    if (s.malformedLines) bits.push(`malformedLines=${s.malformedLines}`)
    return { text: null, blocked: true, reason: bits.join(' '), usage, sessionRef: s.sessionId ?? undefined, toolCalls: s.toolCalls }
  }
  return { text: last, blocked: false, reason: last === null ? 'turn completed without an agent_message' : undefined, usage, sessionRef: s.sessionId ?? undefined, toolCalls: s.toolCalls }
}
