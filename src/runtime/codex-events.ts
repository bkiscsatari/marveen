// OpenAI Codex CLI `codex exec --json` JSONL parser (Phase 2).
//
// Event/item shapes come from the official TypeScript SDK types
// (openai/codex sdk/typescript/src/{events,items}.ts, read 2026-09-22) and
// from a live `codex exec --json` run of codex-cli 0.155.1 on this host
// (src/__tests__/fixtures/codex-cli/auth-failed.jsonl). Pure: no I/O.
//
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.started|item.updated|item.completed","item":{...ThreadItem}}
//   {"type":"turn.completed","usage":{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}}
//   {"type":"turn.failed","error":{"message":"..."}}
//   {"type":"error","message":"..."}
//
// ThreadItem.type: agent_message{text} | reasoning{text} | command_execution
// {command,aggregated_output,exit_code?,status} | file_change{changes[],status}
// | mcp_tool_call{server,tool,arguments,result?,error?,status} | web_search
// {query} | todo_list{items[]} | error{message}.
//
// NOTE (measured): the process exits 0 even when the turn FAILS, so success
// must be read from the events, never from the exit code.

import type { ProviderKind, RunResult, RuntimeKind, ToolCallRecord, UsageRecord } from './types.js'

export interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

export interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregated_output?: string
  exit_code?: number
  status?: string
  changes?: Array<{ path?: string; kind?: string }>
  server?: string
  tool?: string
  arguments?: unknown
  query?: string
  message?: string
  error?: { message?: string }
}

export type CodexEvent =
  | { type: 'thread.started'; thread_id?: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: CodexUsage }
  | { type: 'turn.failed'; error?: { message?: string } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item?: CodexItem }
  | { type: 'error'; message?: string }
  | { type: string; [k: string]: unknown }

export function parseCodexLine(line: string): CodexEvent | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t)
    return o && typeof o === 'object' && typeof o.type === 'string' ? (o as CodexEvent) : null
  } catch {
    return null
  }
}

/** Map a Codex item to the Claude-style tool name the governance hooks match on. */
export function codexItemToolName(item: CodexItem): string | null {
  switch (item.type) {
    case 'command_execution': return 'Bash'
    case 'file_change': return 'Edit'
    case 'web_search': return 'WebSearch'
    case 'mcp_tool_call': return `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`
    default: return null
  }
}

export interface CodexSummary {
  threadId: string | null
  /** agent_message texts in arrival order; the LAST is the final answer. */
  messages: string[]
  reasoning: string[]
  toolCalls: ToolCallRecord[]
  usage: CodexUsage | null
  turnsCompleted: number
  turnFailed: string | null
  /** Top-level `error` events and error items (transport retries, 401s, ...). */
  errors: string[]
  malformedLines: number
}

export class CodexStreamAccumulator {
  private s: CodexSummary = {
    threadId: null, messages: [], reasoning: [], toolCalls: [], usage: null,
    turnsCompleted: 0, turnFailed: null, errors: [], malformedLines: 0,
  }
  private seenCompletedItems = new Set<string>()
  private onText?: (chunk: string) => void

  constructor(opts: { onText?: (chunk: string) => void } = {}) {
    this.onText = opts.onText
  }

  push(line: string): CodexEvent | null {
    const ev = parseCodexLine(line)
    if (!ev) {
      if (line.trim()) this.s.malformedLines++
      return null
    }
    this.consume(ev)
    return ev
  }

  consume(ev: CodexEvent): void {
    const s = this.s
    switch (ev.type) {
      case 'thread.started':
        if (typeof (ev as { thread_id?: unknown }).thread_id === 'string') s.threadId = (ev as { thread_id: string }).thread_id
        break
      case 'turn.completed':
        s.turnsCompleted++
        s.usage = (ev as { usage?: CodexUsage }).usage ?? s.usage
        break
      case 'turn.failed':
        s.turnFailed = (ev as { error?: { message?: string } }).error?.message ?? 'turn failed'
        break
      case 'error':
        s.errors.push((ev as { message?: string }).message ?? 'error')
        break
      case 'item.completed': {
        const item = (ev as { item?: CodexItem }).item
        if (!item) break
        const key = item.id ?? `${item.type}:${s.messages.length}`
        if (this.seenCompletedItems.has(key)) break
        this.seenCompletedItems.add(key)
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          s.messages.push(item.text)
          this.onText?.(item.text)
        } else if (item.type === 'reasoning' && typeof item.text === 'string') {
          s.reasoning.push(item.text)
        } else if (item.type === 'error') {
          s.errors.push(item.message ?? 'error item')
        } else {
          const name = codexItemToolName(item)
          if (name) {
            const ok = item.status ? item.status === 'completed' : undefined
            const input = item.type === 'command_execution' ? { command: item.command }
              : item.type === 'file_change' ? { changes: item.changes }
              : item.type === 'mcp_tool_call' ? item.arguments
              : item.type === 'web_search' ? { query: item.query } : undefined
            s.toolCalls.push({ name, input, ok })
          }
        }
        break
      }
      default:
        break
    }
  }

  summary(): CodexSummary { return this.s }
}

export function usageFromCodex(u: CodexUsage | null, ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp: number; threadId?: string | null }): UsageRecord {
  return {
    inputTokens: Number(u?.input_tokens) || 0,
    outputTokens: Number(u?.output_tokens) || 0,
    cacheReadTokens: Number(u?.cached_input_tokens) || 0,
    cacheCreationTokens: Number(u?.cache_write_input_tokens) || 0,
    thinkingTokens: Number(u?.reasoning_output_tokens) || 0,
    model: ctx.model,
    provider: ctx.provider,
    runtime: ctx.runtime,
    // Codex reports no price; a subscription run has none, an API run is
    // priced later from a rate table (plan section 7).
    costUsd: undefined,
    timestamp: ctx.timestamp,
    sessionRef: ctx.threadId ?? undefined,
  }
}

export function codexShowsAuthFailure(s: CodexSummary): boolean {
  const all = [...s.errors, s.turnFailed ?? '']
  return all.some((m) => /401 Unauthorized|Missing bearer|not logged in|login required|invalid api key|unauthorized/i.test(m))
}

export function codexSummaryToRunResult(
  s: CodexSummary,
  ctx: { runtime: RuntimeKind; provider: ProviderKind; model: string; timestamp?: number; exitCode?: number | null; stderrTail?: string },
): RunResult {
  const usage = usageFromCodex(s.usage, { ...ctx, timestamp: ctx.timestamp ?? Date.now(), threadId: s.threadId })
  const last = s.messages[s.messages.length - 1] ?? null
  // A turn that "completed" with errors and no agent_message is a failure in
  // disguise (observed 2026-09-22: 401 retries, then turn.completed with zero
  // usage and no message) -- never hand that to a caller as a clean empty run.
  const silentFailure = last === null && s.errors.length > 0
  if (s.turnFailed !== null || s.turnsCompleted === 0 || silentFailure) {
    const bits: string[] = []
    if (s.turnFailed !== null) bits.push(`turn.failed=${s.turnFailed.slice(0, 300)}`)
    else if (s.turnsCompleted === 0) bits.push('no turn.completed event')
    else bits.push('turn.completed without agent_message but with errors')
    if (s.errors.length) bits.push(`errors=${s.errors.slice(-2).join('; ').slice(0, 300)}`)
    if (ctx.exitCode !== undefined && ctx.exitCode !== null && ctx.exitCode !== 0) bits.push(`exit=${ctx.exitCode}`)
    if (ctx.stderrTail) bits.push(`stderr=${ctx.stderrTail.slice(-300)}`)
    if (s.malformedLines) bits.push(`malformedLines=${s.malformedLines}`)
    return { text: null, blocked: true, reason: bits.join(' '), usage, sessionRef: s.threadId ?? undefined, toolCalls: s.toolCalls }
  }
  return {
    text: last,
    blocked: false,
    reason: last === null ? 'turn completed without an agent_message' : undefined,
    usage,
    sessionRef: s.threadId ?? undefined,
    toolCalls: s.toolCalls,
  }
}
