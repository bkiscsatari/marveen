// `gemini-cli` runtime adapter (Phase 3): Google Gemini CLI in headless mode,
// for a Google login (Google AI Pro/Ultra, `~/.gemini/oauth_creds.json`) or a
// GEMINI_API_KEY from the vault.
//
//   gemini -p <prompt> --output-format stream-json --approval-mode yolo -m <model> --skip-trust [-r latest]
//
// Per-agent state lives in the agent dir: GEMINI.md (rendered from
// CLAUDE.md+SOUL.md) and .gemini/settings.json (mcpServers + hooks), which the
// CLI layers over ~/.gemini/settings.json. Sessions are per project dir, so
// `--resume latest` continues THIS agent's last conversation (Gemini has no
// resume-by-id; the id is informational). The governance hooks run natively
// through scripts/hooks/shim/gemini-hook.mjs (BeforeTool/AfterTool/BeforeAgent/
// AfterAgent/SessionStart/PreCompress; payload = session_id, transcript_path,
// cwd, hook_event_name, timestamp + tool_name/tool_input/tool_response/prompt,
// read from the 0.60.0 source on 2026-09-22).
//
// NOT exercised against a live login/key on this host (owner to-do).

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { contextLimitForModel } from '../context-guard.js'
import { lookupProviderSecret } from './secret-ids.js'
import { GeminiStreamAccumulator, geminiShowsAuthFailure, geminiSummaryToRunResult } from './gemini-events.js'
import { renderGeminiSettings, renderInstructionsMd, type ClaudeHooksConfig, type McpServerDef } from './bundle-render.js'
import { streamDumper } from './stream-dump.js'
import type {
  AgentHandle, AgentRuntime, AgentSpec, AgentState, HealthProbeResult, RunOptions, RunResult,
  RuntimeCapabilities, SendOptions, SendOutcome, UsageCursor, UsageRecord,
} from './types.js'

const geminiBin = makeLazyBinResolver('gemini')
export const DEFAULT_GEMINI_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000
const KILL_GRACE_MS = 5_000

export type GeminiApprovalMode = 'default' | 'auto_edit' | 'yolo' | 'plan'

export interface GeminiArgsOptions {
  prompt: string
  model: string
  approvalMode: GeminiApprovalMode
  resumeLatest?: boolean
  sessionId?: string
  includeDirectories?: string[]
  allowedMcpServerNames?: string[]
}

/** The prompt travels in argv: `-p` is the documented headless switch and stdin is only appended to it. */
export function buildGeminiArgs(o: GeminiArgsOptions): string[] {
  const args = ['-p', o.prompt, '--output-format', 'stream-json', '--approval-mode', o.approvalMode, '-m', o.model, '--skip-trust']
  if (o.resumeLatest) args.push('-r', 'latest')
  else if (o.sessionId) args.push('--session-id', o.sessionId)
  for (const d of o.includeDirectories ?? []) args.push('--include-directories', d)
  if (o.allowedMcpServerNames && o.allowedMcpServerNames.length) args.push('--allowed-mcp-server-names', ...o.allowedMcpServerNames)
  return args
}

export interface GeminiEnvInputs {
  spec: Pick<AgentSpec, 'id' | 'model' | 'provider' | 'authMode'>
  secretLookup: (id: string) => string | null
  base?: NodeJS.ProcessEnv
}

/** api mode: GEMINI_API_KEY from the vault; subscription: rely on ~/.gemini/oauth_creds.json, NO_BROWSER for headless boxes. */
export function buildGeminiEnv(i: GeminiEnvInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(i.base ?? process.env), NO_BROWSER: 'true', NO_COLOR: '1' }
  delete env.TELEGRAM_BOT_TOKEN; delete env.SLACK_BOT_TOKEN; delete env.SLACK_APP_TOKEN; delete env.DISCORD_BOT_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY; delete env.CODEX_API_KEY
  if (i.spec.authMode === 'api') {
    const key = lookupProviderSecret('google', i.spec.id, i.secretLookup)
    if (key) env.GEMINI_API_KEY = key.value
  } else {
    delete env.GEMINI_API_KEY
  }
  return env
}

export function approvalModeForProfile(permissionMode: 'permissive' | 'strict' | undefined, allowTools: boolean | undefined): GeminiApprovalMode {
  if (allowTools === false) return 'plan'
  if (permissionMode === 'strict') return 'auto_edit'
  return 'yolo'
}

function readJson<T>(p: string): T | null { try { return JSON.parse(readFileSync(p, 'utf-8')) as T } catch { return null } }
function readText(p: string): string | null { try { return readFileSync(p, 'utf-8') } catch { return null } }

export interface PreparedGeminiBundle { settingsPath: string; geminiMdPath: string; skippedHooks: string[] }

/** GEMINI.md (only when absent) + .gemini/settings.json (regenerated: mcpServers + hooks via the shim). */
export function prepareGeminiBundle(spec: AgentSpec, opts: { hooksEnabled?: boolean } = {}): PreparedGeminiBundle {
  const dir = spec.dir
  mkdirSync(join(dir, '.gemini'), { recursive: true })
  const geminiMdPath = join(dir, 'GEMINI.md')
  if (!existsSync(geminiMdPath)) {
    writeFileSync(geminiMdPath, renderInstructionsMd({ displayName: spec.displayName, claudeMd: readText(join(dir, 'CLAUDE.md')), soulMd: readText(join(dir, 'SOUL.md')) }, { target: 'GEMINI.md' }))
  }
  const mcp = { ...(readJson<{ mcpServers?: Record<string, McpServerDef> }>(join(dir, '.mcp.json'))?.mcpServers ?? {}), ...((spec.extraMcpServers ?? {}) as Record<string, McpServerDef>) }
  const settings = readJson<{ hooks?: ClaudeHooksConfig }>(join(dir, '.claude', 'settings.json'))
  const hooksEnabled = opts.hooksEnabled ?? true
  const shim = `${process.execPath} ${join(PROJECT_ROOT, 'scripts', 'hooks', 'shim', 'gemini-hook.mjs')}`
  const r = renderGeminiSettings({ mcpServers: mcp, claudeHooks: hooksEnabled ? settings?.hooks ?? null : null, shimCommand: shim })
  const settingsPath = join(dir, '.gemini', 'settings.json')
  writeFileSync(settingsPath, JSON.stringify(r.settings, null, 2) + '\n')
  return { settingsPath, geminiMdPath, skippedHooks: r.skipped }
}

interface GeminiSession { spec: AgentSpec; hasHistory: boolean; chain: Promise<unknown>; inFlight: number; lastResult: RunResult | null; usage: UsageRecord[]; authFailed: boolean }
const sessions = new Map<string, GeminiSession>()

async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions & { resumeLatest?: boolean } = {}): Promise<RunResult> {
  prepareGeminiBundle(spec)
  const { getSecret } = await import('../web/vault.js')
  const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
  const cwd = opts.cwd ?? spec.dir
  const args = buildGeminiArgs({ prompt, model: spec.model, approvalMode: approvalModeForProfile(undefined, opts.allowTools), resumeLatest: opts.resumeLatest ?? !!opts.resume })
  const env = buildGeminiEnv({ spec, secretLookup, base: { ...process.env, ...(opts.env ?? {}) } })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS
  const startedAt = Date.now()
  const acc = new GeminiStreamAccumulator({ onText: opts.onProgress })
  const dump = streamDumper('gemini-cli', spec.id)
  let stderrTail = ''
  let timedOut = false
  const exitCode = await new Promise<number | null>((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try { child = spawn(geminiBin(), args, { cwd, env }) } catch (err) { stderrTail = `spawn failed: ${(err as Error).message}`; resolve(null); return }
    const timer = setTimeout(() => {
      timedOut = true
      logger.warn({ agent: spec.id, timeoutMs }, 'gemini-cli: run timed out, terminating')
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, KILL_GRACE_MS).unref()
    }, timeoutMs)
    createInterface({ input: child.stdout }).on('line', (line) => { dump?.(line); acc.push(line) })
    child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000) })
    child.on('error', (err) => { stderrTail += ` spawn error: ${err.message}`; clearTimeout(timer); resolve(null) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    child.stdin.end()
  })
  const summary = acc.summary()
  let result = geminiSummaryToRunResult(summary, { runtime: 'gemini-cli', provider: spec.provider, model: spec.model, timestamp: startedAt, exitCode, stderrTail })
  if (timedOut) {
    const mins = Math.round(timeoutMs / 60000)
    result = opts.timeoutAsError
      ? { ...result, text: null, blocked: true, reason: `timeout after ${mins}min` }
      : { ...result, text: `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`, blocked: false }
  }
  if (result.blocked) logger.warn({ agent: spec.id, reason: result.reason, exitCode, auth: geminiShowsAuthFailure(summary, stderrTail) }, 'gemini-cli: run blocked/errored (text=null)')
  if (result.usage && !result.blocked) {
    try { const { recordRuntimeUsage } = await import('./usage-sink.js'); recordRuntimeUsage(spec.id, result.usage, { contentPreview: prompt.slice(0, 200) }) }
    catch (err) { logger.debug({ err }, 'gemini-cli: usage sink unavailable (skipped)') }
  }
  return result
}

export const geminiCliRuntime: AgentRuntime = {
  kind: 'gemini-cli',
  capabilities(agent: AgentSpec): RuntimeCapabilities {
    return { interactive: false, supportsResume: true, supportsHooks: 'native', supportsMcp: true, supportsChannelsPlugin: false, reportsUsage: 'events', contextWindow: contextLimitForModel(agent.model) }
  },
  async spawn(agent: AgentSpec, opts: { fresh?: boolean } = {}): Promise<AgentHandle> {
    const ref = `gemini:${agent.id}:${randomBytes(4).toString('hex')}`
    let prior = false
    if (!opts.fresh) for (const [k, s] of sessions) if (s.spec.id === agent.id) { prior = s.hasHistory; sessions.delete(k) }
    prepareGeminiBundle(agent)
    sessions.set(ref, { spec: agent, hasHistory: prior, chain: Promise.resolve(), inFlight: 0, lastResult: null, usage: [], authFailed: false })
    return { agentId: agent.id, runtime: 'gemini-cli', sessionRef: ref, host: null }
  },
  async send(handle: AgentHandle, prompt: string, _opts: SendOptions = {}): Promise<SendOutcome> {
    const s = sessions.get(handle.sessionRef)
    if (!s) throw new Error(`gemini-cli: unknown handle ${handle.sessionRef}`)
    s.inFlight++
    const run = s.chain.then(async () => {
      const r = await runOnce(s.spec, prompt, { resumeLatest: s.hasHistory, allowTools: true, timeoutAsError: true })
      s.lastResult = r
      if (!r.blocked) s.hasHistory = true
      if (r.usage && !r.blocked) s.usage.push(r.usage)
      s.authFailed = r.blocked && /Auth method|GEMINI_API_KEY|UNAUTHENTICATED|401/i.test(r.reason ?? '')
    }).catch((err) => { logger.error({ err, agent: s.spec.id }, 'gemini-cli: send failed') }).finally(() => { s.inFlight-- })
    s.chain = run
    return 'sent'
  },
  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> { return runOnce(agent, prompt, opts) },
  async state(handle: AgentHandle): Promise<AgentState> {
    const s = sessions.get(handle.sessionRef)
    if (!s) return 'dead'
    if (s.inFlight > 0) return 'busy'
    if (s.authFailed) return 'auth'
    if (s.lastResult?.blocked && /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(s.lastResult.reason ?? '')) return 'blocked'
    return 'idle'
  },
  async stop(handle: AgentHandle): Promise<void> { sessions.delete(handle.sessionRef) },
  async usageSince(handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }> {
    const all = sessions.get(handle.sessionRef)?.usage ?? []
    const from = typeof cursor?.value === 'number' ? cursor.value : 0
    return { records: all.slice(from), cursor: { value: all.length } }
  },
  async healthProbe(agent: AgentSpec): Promise<HealthProbeResult> {
    let version = ''
    try { version = execFileSync(geminiBin(), ['--version'], { encoding: 'utf-8', timeout: 15_000 }).trim() } catch (err) { return { ok: false, detail: `gemini not runnable: ${(err as Error).message}` } }
    if (agent.authMode === 'api') {
      const { getSecret } = await import('../web/vault.js')
      const key = lookupProviderSecret('google', agent.id, (id) => { try { return getSecret(id) } catch { return null } })
      return key ? { ok: true, detail: `gemini-cli ${version}; api key from vault (${key.id})` } : { ok: false, detail: `gemini-cli ${version}; no Gemini key in vault (expected GEMINI_API_KEY / provider:google:api-key)` }
    }
    const creds = join(homedir(), '.gemini', 'oauth_creds.json')
    return existsSync(creds)
      ? { ok: true, detail: `gemini-cli ${version}; Google login present (${creds})` }
      : { ok: false, detail: `gemini-cli ${version}; no Google login (run: NO_BROWSER=true gemini, then paste the auth code)` }
  },
}

export default geminiCliRuntime
