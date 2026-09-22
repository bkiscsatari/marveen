// PolicyEngine (Phase 4): runs Marveen's governance hooks IN-PROCESS for
// runtimes that have no hook system of their own (native-api), using the very
// same scripts and the very same Claude Code hook protocol the fleet already
// relies on -- so a gate added to .claude/settings.json protects every runtime.
//
// Protocol (Claude Code, mirrored by Codex/Gemini through the shims):
//   stdin  : {session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input, tool_response?, prompt?}
//   exit 2 : BLOCK (stderr = reason)             exit 0: allow, stdout parsed
//   stdout : JSON {decision:"deny"|"block"|"allow", reason, hookSpecificOutput:{permissionDecision, permissionDecisionReason, updatedInput, additionalContext}}
//            or plain text = additional context injected into the prompt
//   other exit codes: non-fatal warning (allow)
// Matchers are regexes on the tool name (empty = all). Timeouts in seconds.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { logger } from '../../logger.js'
import type { ClaudeHookEntry, ClaudeHooksConfig } from '../bundle-render.js'

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart' | 'PreCompact' | 'SessionEnd'

export interface HookPayload {
  session_id: string
  transcript_path: string
  cwd: string
  hook_event_name: HookEventName
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  prompt?: string
  [k: string]: unknown
}

export interface HookRunOutcome {
  hook: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export interface PolicyDecision {
  allowed: boolean
  reason?: string
  /** Rewritten tool input (PreToolUse updatedInput). */
  updatedInput?: unknown
  /** Text the hooks want injected into the model's context. */
  additionalContext: string[]
  outcomes: HookRunOutcome[]
}

const DEFAULT_TIMEOUT_S = 60

export function hooksFor(config: ClaudeHooksConfig | null | undefined, event: HookEventName, toolName: string | undefined): ClaudeHookEntry[] {
  const out: ClaudeHookEntry[] = []
  for (const g of config?.[event] ?? []) {
    if (g.matcher && g.matcher.trim() && toolName !== undefined) {
      let rx: RegExp
      try { rx = new RegExp(`^(?:${g.matcher})$`) } catch { rx = new RegExp(g.matcher) }
      if (!rx.test(toolName)) continue
    } else if (g.matcher && g.matcher.trim() && toolName === undefined && event !== 'PreCompact' && event !== 'SessionStart') {
      // A matcher on a non-tool event (Claude Code ignores it for UserPromptSubmit/Stop) -> run.
    }
    for (const h of g.hooks ?? []) if (h.type === 'command' && h.command) out.push(h)
  }
  return out
}

/** Pure: interpret one hook's reply in the Claude Code dialect. */
export function interpretHookReply(o: HookRunOutcome): { deny: boolean; reason?: string; updatedInput?: unknown; context?: string } {
  const out = o.stdout.trim()
  if (o.timedOut) return { deny: false, reason: `hook timed out (${o.hook}) -- allowed (fail-open on timeout)` }
  if (o.exitCode === 2) return { deny: true, reason: (o.stderr.trim() || out || `blocked by ${o.hook}`).slice(0, 500) }
  if (!out) return { deny: false }
  let json: Record<string, unknown> | null = null
  try { json = JSON.parse(out) } catch { json = null }
  if (!json || typeof json !== 'object') return { deny: false, context: out }
  const hso = (json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object') ? json.hookSpecificOutput as Record<string, unknown> : {}
  const deny = json.decision === 'deny' || json.decision === 'block' || hso.permissionDecision === 'deny' || json.continue === false
  const reason = (json.reason ?? hso.permissionDecisionReason ?? json.stopReason) as string | undefined
  const updatedInput = hso.updatedInput
  const ctx = typeof hso.additionalContext === 'string' ? hso.additionalContext : typeof json.additionalContext === 'string' ? json.additionalContext : undefined
  return { deny, reason, updatedInput, context: ctx }
}

export class PolicyEngine {
  constructor(
    private readonly config: ClaudeHooksConfig | null | undefined,
    private readonly ctx: { sessionId: string; cwd: string; transcriptPath?: string; env?: NodeJS.ProcessEnv; repoRoot?: string },
  ) {}

  private payload(event: HookEventName, extra: Record<string, unknown>): HookPayload {
    return {
      session_id: this.ctx.sessionId,
      transcript_path: this.ctx.transcriptPath ?? '',
      cwd: this.ctx.cwd,
      hook_event_name: event,
      _marveen_runtime: 'native-api',
      ...extra,
    }
  }

  private async runHook(h: ClaudeHookEntry, payload: HookPayload): Promise<HookRunOutcome> {
    const started = Date.now()
    const timeoutMs = (h.timeout ?? DEFAULT_TIMEOUT_S) * 1000
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', h.command!], {
        cwd: this.ctx.cwd,
        env: { ...(this.ctx.env ?? process.env), MARVEEN_HOOK_RUNTIME: 'native-api', CLAUDE_PROJECT_DIR: this.ctx.repoRoot ?? this.ctx.cwd },
      })
      let stdout = ''; let stderr = ''; let timedOut = false
      const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('error', (err) => { clearTimeout(timer); resolve({ hook: h.command!, exitCode: null, stdout, stderr: stderr + ` spawn error: ${err.message}`, durationMs: Date.now() - started, timedOut }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ hook: h.command!, exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut }) })
      child.stdin.on('error', () => { /* hook exited before reading */ })
      child.stdin.end(JSON.stringify(payload))
    })
  }

  private async fire(event: HookEventName, toolName: string | undefined, extra: Record<string, unknown>): Promise<PolicyDecision> {
    const hooks = hooksFor(this.config, event, toolName)
    const decision: PolicyDecision = { allowed: true, additionalContext: [], outcomes: [] }
    if (!hooks.length) return decision
    const payload = this.payload(event, extra)
    // Sequential, first deny wins (a gate must never be outrun by a sibling).
    for (const h of hooks) {
      const o = await this.runHook(h, payload)
      decision.outcomes.push(o)
      const r = interpretHookReply(o)
      if (r.context) decision.additionalContext.push(r.context)
      if (r.updatedInput !== undefined) decision.updatedInput = r.updatedInput
      if (r.deny) {
        decision.allowed = false
        decision.reason = r.reason ?? `blocked by ${o.hook}`
        logger.warn({ event, toolName, hook: o.hook.slice(0, 120), reason: decision.reason }, 'policy-engine: hook blocked')
        return decision
      }
      if (o.exitCode !== 0 && o.exitCode !== null && !o.timedOut) {
        logger.warn({ event, hook: o.hook.slice(0, 120), exitCode: o.exitCode, stderr: o.stderr.slice(0, 200) }, 'policy-engine: hook failed (non-blocking)')
      }
    }
    return decision
  }

  preToolUse(toolName: string, toolInput: unknown): Promise<PolicyDecision> {
    return this.fire('PreToolUse', toolName, { tool_name: toolName, tool_input: toolInput })
  }
  postToolUse(toolName: string, toolInput: unknown, toolResponse: unknown): Promise<PolicyDecision> {
    return this.fire('PostToolUse', toolName, { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse })
  }
  userPromptSubmit(prompt: string): Promise<PolicyDecision> {
    return this.fire('UserPromptSubmit', undefined, { prompt })
  }
  /** Turn end; a deny means "do not stop yet" (e.g. telegram-reply-guard). */
  stop(lastAssistantText: string | null): Promise<PolicyDecision> {
    return this.fire('Stop', undefined, { stop_hook_active: false, last_assistant_message: lastAssistantText ?? '' })
  }
  sessionStart(source: 'startup' | 'resume' | 'compact' = 'startup'): Promise<PolicyDecision> {
    return this.fire('SessionStart', undefined, { source })
  }
}

export function transcriptPathFor(agentDir: string, sessionId: string): string {
  return join(agentDir, '.marveen', 'transcripts', `${sessionId}.jsonl`)
}
