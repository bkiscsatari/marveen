// `native-api` runtime adapter (Phase 4): Marveen's own agent loop on the
// Vercel AI SDK -- any vendor with an API key (or a local Ollama), no CLI.
//
// One turn = generateText({ model, system, messages, tools, stopWhen }) where
// tools = built-ins (Read/Write/Edit/Bash/ListDir/WebFetch) + the agent's
// MCP servers, every call gated by the permission list and the PolicyEngine
// (the same governance hook scripts as Claude Code). History lives in
// runtime_sessions (provider-independent resume). The system prompt is the
// rendered instructions (CLAUDE.md + SOUL.md) plus the skills index.

import { generateText, stepCountIs, type ModelMessage, type ToolSet } from 'ai'
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
import { builtinTools, readOnlyToolNames, type ToolContext } from './tools.js'
import { connectMcpServer, mcpToolSet, closeAll, type McpConnection } from './mcp-client.js'
import { loadSession, saveSession, newSessionId, appendTranscript, trimHistory } from './history.js'
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

async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const startedAt = Date.now()
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
  const permissions = buildPermissionSet(settings?.permissions, permissionMode, { AGENT_DIR: spec.dir, HOME: homedir() })
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

  // UserPromptSubmit hooks: may block the prompt or inject context.
  const ups = await policy.userPromptSubmit(prompt)
  if (!ups.allowed) { await closeAll(conns); return { text: null, blocked: true, reason: `prompt blocked by hook: ${ups.reason}`, sessionRef: sessionId, toolCalls } }
  if (!prior) await policy.sessionStart('startup')
  const userText = ups.additionalContext.length ? `${ups.additionalContext.join('\n')}\n\n${prompt}` : prompt

  const messages: ModelMessage[] = [...(prior?.messages ?? []), { role: 'user', content: userText }]
  appendTranscript(transcriptPath, { type: 'user', text: prompt })
  const ac = new AbortController()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let result
  try {
    result = await generateText({
      model,
      system: systemPromptFor(spec),
      messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: ac.signal,
      onStepFinish: (step) => { if (step.text) opts.onProgress?.(step.text) },
    })
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
    return { text: null, blocked: true, reason: `${auth ? 'auth: ' : ''}${msg.slice(0, 500)}`, sessionRef: sessionId, toolCalls }
  }
  clearTimeout(timer)
  await closeAll(conns)

  const text = result.text?.trim() ? result.text : null
  // Stop hooks (e.g. telegram-reply-guard): a deny is reported, not looped -- the
  // caller (Phase 5 bridge) re-prompts with the reason, mirroring Claude Code.
  const stop = await policy.stop(text)
  const u = result.usage
  const usage: UsageRecord = {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheCreationTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    thinkingTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
    model: spec.model, provider: spec.provider, runtime: 'native-api', timestamp: startedAt, sessionRef: sessionId,
  }
  const history = trimHistory([...messages, ...result.responseMessages], MAX_HISTORY_MESSAGES)
  saveSession({ id: sessionId, agent: spec.id, runtime: 'native-api', provider: spec.provider, model: spec.model, messages: history, turns: (prior?.turns ?? 0) + 1, created_at: prior?.created_at })
  appendTranscript(transcriptPath, { type: 'assistant', text, finishReason: result.finishReason, steps: result.steps.length })
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
