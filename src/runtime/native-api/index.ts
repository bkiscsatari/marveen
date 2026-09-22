// `native-api` runtime adapter (Phase 4): Marveen's own agent loop on the
// Vercel AI SDK -- any vendor with an API key (or a local Ollama), no CLI.
//
// One turn = generateText({ model, system, messages, tools, stopWhen }) where
// tools = built-ins (Read/Write/Edit/Bash/ListDir/WebFetch) + the agent's
// MCP servers, every call gated by the permission list and the PolicyEngine
// (the same governance hook scripts as Claude Code). History lives in
// runtime_sessions (provider-independent resume). The system prompt is the
// rendered instructions (CLAUDE.md + SOUL.md) plus the skills index.

import { generateText, stepCountIs, type LanguageModelUsage, type ModelMessage, type ToolSet } from 'ai'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../../logger.js'
import { PROJECT_ROOT } from '../../config.js'
import { contextLimitForModel } from '../../context-guard.js'
import { buildPermissionSet } from '../permissions.js'
import { PolicyEngine, transcriptPathFor } from '../policy/engine.js'
import { renderInstructionsMd, type ClaudeHooksConfig, type McpServerDef } from '../bundle-render.js'
import { modelFor, MissingApiKeyError } from './provider.js'
import { builtinTools, readOnlyToolNames, resolveToolPath, type ToolContext } from './tools.js'
import { connectMcpServer, mcpToolSet, closeAll, type McpConnection } from './mcp-client.js'
import { loadSession, saveSession, newSessionId, appendTranscript, trimHistory, pruneRuntimeSessions } from './history.js'
import { noteRunOutcome } from '../quota-state.js'
import type {
  AgentHandle, AgentRuntime, AgentSpec, AgentState, HealthProbeResult, RunOptions, RunResult,
  RuntimeCapabilities, SendOptions, SendOutcome, ToolCallRecord, UsageCursor, UsageRecord,
} from '../types.js'

export const DEFAULT_NATIVE_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000
const MAX_STEPS = Number(process.env.MARVEEN_NATIVE_MAX_STEPS) || 40
const MAX_HISTORY_MESSAGES = 200

function readJson<T>(p: string): T | null { try { return JSON.parse(readFileSync(p, 'utf-8')) as T } catch { return null } }
function readText(p: string): string | null { try { return readFileSync(p, 'utf-8') } catch { return null } }

/** Skills index from <dir>/.claude/skills/<name>/SKILL.md (name + first description line). */
export function listSkills(dir: string): Array<{ name: string; path: string; description?: string }> {
  const root = join(dir, '.claude', 'skills')
  if (!existsSync(root)) return []
  const out: Array<{ name: string; path: string; description?: string }> = []
  for (const name of readdirSync(root)) {
    const p = join(root, name, 'SKILL.md')
    if (!existsSync(p)) continue
    const head = readText(p) ?? ''
    const m = head.match(/^description:\s*(.+)$/m)
    out.push({ name, path: `.claude/skills/${name}/SKILL.md`, description: m?.[1]?.trim() })
  }
  return out
}

export function systemPromptFor(spec: AgentSpec): string {
  const claudeMd = readText(join(spec.dir, 'CLAUDE.md'))
  const soulMd = readText(join(spec.dir, 'SOUL.md'))
  const skills = listSkills(spec.dir)
  const body = renderInstructionsMd({ displayName: spec.displayName, claudeMd, soulMd, skills }, { target: 'AGENTS.md' })
  return [
    body.replace(/^<!--.*?-->\n?/s, ''),
    `\n## Runtime\nYou run on the Marveen native-api runtime (model ${spec.model} via ${spec.provider}). Working directory: ${spec.dir}. Tools: Read, Write, Edit, Bash, ListDir, WebFetch and any mcp__* tools listed. A tool reply starting with "ERROR: ... blocked" is a governance decision: do not retry it, explain and choose another route.`,
  ].join('\n')
}

interface Session { spec: AgentSpec; sessionId: string | null; chain: Promise<unknown>; inFlight: number; lastResult: RunResult | null; usage: UsageRecord[]; authFailed: boolean }
const sessions = new Map<string, Session>()

// runtime_sessions rows were never deleted; prune stale ones at most every 6 h.
let lastPruneAt = 0
function maybePruneSessions(now: number): void {
  if (now - lastPruneAt < 6 * 3600_000) return
  lastPruneAt = now
  try { const n = pruneRuntimeSessions(30); if (n) logger.info({ pruned: n }, 'native-api: stale runtime sessions pruned') }
  catch (err) { logger.debug({ err }, 'native-api: session prune failed') }
}

async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now()
  maybePruneSessions(startedAt)
  const { getSecret } = await import('../../web/vault.js')
  const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
  const cwd = opts.cwd ?? spec.dir
  const sessionId = opts.resume ?? newSessionId()
  const prior = opts.resume ? loadSession(opts.resume) : null
  const transcriptPath = transcriptPathFor(spec.dir, sessionId)

  // Governance: permission list + hooks from the agent's own settings.
  const settings = readJson<{ hooks?: ClaudeHooksConfig; permissions?: { allow?: string[]; deny?: string[] } }>(join(spec.dir, '.claude', 'settings.json'))
  const profile = readJson<{ permissionMode?: string }>(join(PROJECT_ROOT, 'templates', 'profiles', `${spec.securityProfile}.json`))
  const permissionMode: 'permissive' | 'strict' = profile?.permissionMode === 'strict' ? 'strict' : 'permissive'
  // Placeholders expand to CANONICAL paths: the tools judge realpath'd
  // arguments (resolveToolPath), so a symlinked agent dir must not make every
  // allow rule miss.
  const canon = (p: string) => resolveToolPath('/', p)
  const permissions = buildPermissionSet(settings?.permissions, permissionMode, { AGENT_DIR: canon(spec.dir), HOME: canon(homedir()), PROJECT_ROOT: canon(PROJECT_ROOT) })
  const policy = new PolicyEngine(settings?.hooks, { sessionId, cwd, transcriptPath, repoRoot: PROJECT_ROOT })

  let model
  try { model = modelFor({ agentId: spec.id, provider: spec.provider, model: spec.model, secretLookup }) }
  catch (err) {
    const reason = err instanceof MissingApiKeyError ? `auth: ${err.message}` : `model factory failed: ${(err as Error).message}`
    return { text: null, blocked: true, reason, sessionRef: sessionId }
  }

  const toolCalls: ToolCallRecord[] = []
  const toolCtx: ToolContext = { cwd, permissions, policy, onCall: (r) => { toolCalls.push({ name: r.name, input: r.input, ok: r.ok }); appendTranscript(transcriptPath, { type: 'tool', ...r }) } }
  let tools: ToolSet = builtinTools(toolCtx)
  if (opts.allowTools === false) {
    const keep = new Set(readOnlyToolNames())
    tools = Object.fromEntries(Object.entries(tools).filter(([k]) => keep.has(k)))
  }
  const conns: McpConnection[] = []
  if (opts.allowTools !== false) {
    const mcp = { ...(readJson<{ mcpServers?: Record<string, McpServerDef> }>(join(spec.dir, '.mcp.json'))?.mcpServers ?? {}), ...((spec.extraMcpServers ?? {}) as Record<string, McpServerDef>) }
    for (const [name, def] of Object.entries(mcp)) {
      try { conns.push(await connectMcpServer(name, def, { cwd })) }
      catch (err) { logger.warn({ err, server: name, agent: spec.id }, 'native-api: MCP server connect failed (skipped)') }
    }
    if (conns.length) Object.assign(tools, await mcpToolSet(conns, toolCtx))
  }

  // SessionStart runs FIRST (Claude Code order) and its context -- ledger/
  // taskstate replay -- reaches the model; the first version fired it after
  // the prompt hooks and threw the result away. A resumed session gets
  // source=resume, so replay hooks keyed on it behave as on Claude.
  const ss = await policy.sessionStart(prior ? 'resume' : 'startup')
  // UserPromptSubmit hooks: may block the prompt or inject context.
  const ups = await policy.userPromptSubmit(prompt)
  if (!ups.allowed) { await closeAll(conns); return { text: null, blocked: true, reason: `prompt blocked by hook: ${ups.reason}`, sessionRef: sessionId, toolCalls } }
  const injected = [...ss.additionalContext, ...ups.additionalContext]
  const userText = injected.length ? `${injected.join('\n')}\n\n${prompt}` : prompt

  let messages: ModelMessage[] = [...(prior?.messages ?? []), { role: 'user', content: userText }]
  appendTranscript(transcriptPath, { type: 'user', text: prompt })
  const ac = new AbortController()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let result
  let stop: Awaited<ReturnType<PolicyEngine['stop']>> = { allowed: true, additionalContext: [], outcomes: [] }
  const passUsages: LanguageModelUsage[] = []
  try {
    // Stop hooks follow Claude Code: a deny ("block") means the turn may NOT
    // end yet -- the reason goes back to the model as feedback and it
    // continues. One continuation, then stop_hook_active=true semantics: a
    // second deny is reported in `reason`, never looped.
    for (let pass = 0; pass < 2; pass++) {
      result = await generateText({
        model,
        system: systemPromptFor(spec),
        messages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: ac.signal,
        onStepFinish: (step) => { if (step.text) opts.onProgress?.(step.text) },
      })
      passUsages.push(result.usage)
      const passText = result.text?.trim() ? result.text : null
      stop = await policy.stop(passText, pass > 0)
      if (stop.allowed || pass > 0) break
      messages = [...messages, ...result.responseMessages, { role: 'user', content: `[stop-hook] ${stop.reason ?? 'the turn may not end yet'}` }]
      appendTranscript(transcriptPath, { type: 'stop-hook', reason: stop.reason })
    }
  } catch (err) {
    clearTimeout(timer); await closeAll(conns)
    const aborted = ac.signal.aborted
    const msg = (err as Error).message ?? String(err)
    if (aborted) {
      const mins = Math.round(timeoutMs / 60000)
      return opts.timeoutAsError
        ? { text: null, blocked: true, reason: `timeout after ${mins}min`, sessionRef: sessionId, toolCalls }
        : { text: `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`, blocked: false, sessionRef: sessionId, toolCalls }
    }
    const auth = /401|403|unauthorized|invalid.*api key|authentication/i.test(msg)
    logger.warn({ agent: spec.id, err: msg.slice(0, 300), auth }, 'native-api: generateText failed')
    const failed: RunResult = { text: null, blocked: true, reason: `${auth ? 'auth: ' : ''}${msg.slice(0, 500)}`, sessionRef: sessionId, toolCalls }
    noteRunOutcome('native-api', spec.provider, failed)
    return failed
  }
  clearTimeout(timer)
  await closeAll(conns)
  if (!result) return { text: null, blocked: true, reason: 'no model result', sessionRef: sessionId, toolCalls }

  const text = result.text?.trim() ? result.text : null
  // Sum over both passes when a Stop hook asked for a continuation.
  const sum = (f: (u: LanguageModelUsage) => number | undefined) => passUsages.reduce((a, u) => a + (f(u) ?? 0), 0)
  const usage: UsageRecord = {
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cacheReadTokens: sum((u) => u.inputTokenDetails?.cacheReadTokens),
    cacheCreationTokens: sum((u) => u.inputTokenDetails?.cacheWriteTokens),
    thinkingTokens: sum((u) => u.outputTokenDetails?.reasoningTokens),
    model: spec.model, provider: spec.provider, runtime: 'native-api', timestamp: startedAt, sessionRef: sessionId,
  }
  // Size budget: ~half the context window in characters (≈ tokens × 2), so the
  // next turn's prompt, system text and tool output still fit.
  const history = trimHistory([...messages, ...result.responseMessages], MAX_HISTORY_MESSAGES, contextLimitForModel(spec.model) * 2)
  saveSession({ id: sessionId, agent: spec.id, runtime: 'native-api', provider: spec.provider, model: spec.model, messages: history, turns: (prior?.turns ?? 0) + 1, created_at: prior?.created_at })
  appendTranscript(transcriptPath, { type: 'assistant', text, finishReason: result.finishReason, steps: result.steps.length })
  noteRunOutcome('native-api', spec.provider, { blocked: false })
  try { const { recordRuntimeUsage } = await import('../usage-sink.js'); recordRuntimeUsage(spec.id, usage, { contentPreview: prompt.slice(0, 200) }) }
  catch (err) { logger.debug({ err }, 'native-api: usage sink unavailable (skipped)') }
  return {
    text,
    blocked: false,
    reason: !stop.allowed ? `stop hook: ${stop.reason}` : text === null ? `finished (${result.finishReason}) without text` : undefined,
    usage, sessionRef: sessionId, toolCalls,
  }
}

export const nativeApiRuntime: AgentRuntime = {
  kind: 'native-api',
  capabilities(agent: AgentSpec): RuntimeCapabilities {
    return { interactive: false, supportsResume: true, supportsHooks: 'policy-engine', supportsMcp: true, supportsChannelsPlugin: false, reportsUsage: 'events', contextWindow: contextLimitForModel(agent.model) }
  },
  async spawn(agent: AgentSpec, opts: { fresh?: boolean } = {}): Promise<AgentHandle> {
    const ref = `native:${agent.id}:${newSessionId().slice(0, 8)}`
    let prior: string | null = null
    if (!opts.fresh) {
      for (const [k, s] of sessions) if (s.spec.id === agent.id && s.sessionId) { prior = s.sessionId; sessions.delete(k) }
      if (!prior) { const { latestSessionFor } = await import('./history.js'); prior = latestSessionFor(agent.id, 'native-api')?.id ?? null }
    }
    sessions.set(ref, { spec: agent, sessionId: prior, chain: Promise.resolve(), inFlight: 0, lastResult: null, usage: [], authFailed: false })
    return { agentId: agent.id, runtime: 'native-api', sessionRef: ref, host: null }
  },
  async send(handle: AgentHandle, prompt: string, _opts: SendOptions = {}): Promise<SendOutcome> {
    const s = sessions.get(handle.sessionRef)
    if (!s) throw new Error(`native-api: unknown handle ${handle.sessionRef}`)
    s.inFlight++
    const run = s.chain.then(async () => {
      const r = await runOnce(s.spec, prompt, { resume: s.sessionId ?? undefined, allowTools: true, timeoutAsError: true })
      s.lastResult = r
      if (r.sessionRef) s.sessionId = r.sessionRef
      if (r.usage) s.usage.push(r.usage)
      s.authFailed = r.blocked && /^auth:/.test(r.reason ?? '')
    }).catch((err) => { logger.error({ err, agent: s.spec.id }, 'native-api: send failed') }).finally(() => { s.inFlight-- })
    s.chain = run
    return 'sent'
  },
  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> { return runOnce(agent, prompt, opts) },
  async state(handle: AgentHandle): Promise<AgentState> {
    const s = sessions.get(handle.sessionRef)
    if (!s) return 'dead'
    if (s.inFlight > 0) return 'busy'
    if (s.authFailed) return 'auth'
    if (s.lastResult?.blocked && /429|rate limit|quota|RESOURCE_EXHAUSTED/i.test(s.lastResult.reason ?? '')) return 'blocked'
    return 'idle'
  },
  async stop(handle: AgentHandle): Promise<void> { sessions.delete(handle.sessionRef) },
  async usageSince(handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }> {
    const all = sessions.get(handle.sessionRef)?.usage ?? []
    const from = typeof cursor?.value === 'number' ? cursor.value : 0
    return { records: all.slice(from), cursor: { value: all.length } }
  },
  async healthProbe(agent: AgentSpec): Promise<HealthProbeResult> {
    const r = await runOnce({ ...agent }, 'Reply with exactly: OK', { timeoutMs: 120_000, timeoutAsError: true, allowTools: false })
    if (r.text && /\bOK\b/i.test(r.text)) return { ok: true, detail: `answered on ${agent.provider}/${agent.model}` }
    return { ok: false, detail: r.reason ?? `unexpected reply: ${(r.text ?? '').slice(0, 80)}` }
  },
}

export default nativeApiRuntime
