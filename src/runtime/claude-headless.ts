// `claude-headless` runtime adapter (Phase 1).
//
// Runs Claude Code as a child process in print mode:
//   claude -p --output-format stream-json --verbose --model <m> [--resume <id>] ...
// The prompt goes in on STDIN (never argv: no `ps` leak, no ARG_MAX), the
// JSONL event stream comes out on stdout and is folded by stream-json.ts into
// a RunResult. Nothing here touches tmux or scrapes a pane.
//
// Isolation, same reasons as the interactive worker (web/agent-worker.ts):
// an isolated CLAUDE_CONFIG_DIR with every channel plugin disabled, so a
// headless run can never open a second Telegram getUpdates poll (the 409
// class), plus --strict-mcp-config with the agent's own mcp.json (or an
// empty one) so host-level MCP servers do not leak into one-shot runs.
//
// Verified live 2026-09-22 (Claude Code 2.1.278): text reply, tool use,
// --resume continuity, two-turn --input-format stream-json, and the
// rate_limit_event that carries the 5h/7d subscription utilisation.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, DEFAULT_AGENT_MODEL } from '../config.js'
import { contextLimitForModel } from '../context-guard.js'
import { resolveProviderEnvVars } from './anthropic-compat-env.js'
import { lookupProviderSecret } from './secret-ids.js'
import { ClaudeStreamAccumulator, streamShowsAuthFailure, summaryToRunResult, type RateLimitInfo } from './stream-json.js'
import { streamDumper } from './stream-dump.js'
import type {
  AgentHandle, AgentRuntime, AgentSpec, AgentState, HealthProbeResult, RunOptions, RunResult,
  RuntimeCapabilities, SendOptions, SendOutcome, UsageCursor, UsageRecord,
} from './types.js'

const claudeBin = makeLazyBinResolver('claude')

// Same tool set runAgent's SDK path disallows for pure text generation
// (src/agent.ts DEFAULT_DISALLOWED_TOOLS): a generator that Writes the file
// itself then returns "Kész" instead of the content corrupts the target.
export const HEADLESS_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task'] as const

export const DEFAULT_HEADLESS_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000
const KILL_GRACE_MS = 5_000

// --- pure builders (unit-tested) ---------------------------------------------

export interface HeadlessArgsOptions {
  model: string
  resume?: string
  sessionId?: string
  disallowedTools?: readonly string[]
  /** Path to an mcp.json; with strictMcp only its servers load. */
  mcpConfigPath?: string
  strictMcp?: boolean
  /** Inline settings JSON (e.g. enabledPlugins overrides). */
  settingsJson?: string
  permissionMode?: 'bypassPermissions' | 'default' | 'acceptEdits' | 'plan'
  noSessionPersistence?: boolean
  appendSystemPrompt?: string
}

export function buildHeadlessArgs(o: HeadlessArgsOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', o.model]
  args.push('--permission-mode', o.permissionMode ?? 'bypassPermissions')
  if (o.resume) args.push('--resume', o.resume)
  else if (o.sessionId) args.push('--session-id', o.sessionId)
  if (o.disallowedTools && o.disallowedTools.length) args.push('--disallowedTools', ...o.disallowedTools)
  if (o.mcpConfigPath) {
    args.push('--mcp-config', o.mcpConfigPath)
    if (o.strictMcp !== false) args.push('--strict-mcp-config')
  }
  if (o.settingsJson) args.push('--settings', o.settingsJson)
  if (o.noSessionPersistence) args.push('--no-session-persistence')
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt)
  return args
}

export interface HeadlessEnvInputs {
  spec: Pick<AgentSpec, 'id' | 'model' | 'provider' | 'authMode'>
  configDir: string
  /** Fleet subscription token (CLAUDE_CODE_OAUTH_TOKEN), if any. */
  oauthToken: string | null
  secretLookup: (id: string) => string | null
  base?: NodeJS.ProcessEnv
}

/**
 * Environment for the child. Subscription auth = the fleet OAuth token;
 * api auth = ANTHROPIC_API_KEY from the vault (per-agent override first).
 * Non-Anthropic vendors get the Anthropic-compatible redirect vars.
 */
export function buildHeadlessEnv(i: HeadlessEnvInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(i.base ?? process.env),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
    CLAUDE_CONFIG_DIR: i.configDir,
  }
  // Never inherit channel bot tokens into a one-shot process.
  delete env.TELEGRAM_BOT_TOKEN; delete env.SLACK_BOT_TOKEN; delete env.SLACK_APP_TOKEN; delete env.DISCORD_BOT_TOKEN
  if (i.spec.provider === 'anthropic') {
    if (i.spec.authMode === 'api') {
      const key = lookupProviderSecret('anthropic', i.spec.id, i.secretLookup)
      if (key) { env.ANTHROPIC_API_KEY = key.value; delete env.CLAUDE_CODE_OAUTH_TOKEN }
      else if (i.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = i.oauthToken
    } else if (i.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = i.oauthToken
    }
  } else {
    Object.assign(env, resolveProviderEnvVars(i.spec.model, i.secretLookup))
  }
  return env
}

/** Fleet OAuth token precedence: process env > .env line > store/.claude-oauth-token. */
export function resolveFleetOauthToken(opts: { env?: NodeJS.ProcessEnv; readEnv?: () => string | undefined; readStoreFile?: () => string | null } = {}): string | null {
  const fromProc = (opts.env ?? process.env).CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (fromProc) return fromProc
  const fromEnvFile = (opts.readEnv ?? (() => readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN'])['CLAUDE_CODE_OAUTH_TOKEN']))()?.trim()
  if (fromEnvFile) return fromEnvFile.replace(/^"|"$/g, '')
  const fromStore = (opts.readStoreFile ?? defaultReadStoreToken)()
  return fromStore?.trim() || null
}

function defaultReadStoreToken(): string | null {
  try {
    const p = join(PROJECT_ROOT, 'store', '.claude-oauth-token')
    if (!existsSync(p)) return null
    return readFileSync(p, 'utf-8')
  } catch { return null }
}

// Feature flag lives in flags.ts (pure, cycle-free) -- re-exported for callers.
export { workerRuntimeKind } from './flags.js'

// --- isolated home / config dir ---------------------------------------------

/** ~/.<main-agent-id>-headless : neutral cwd + isolated CLAUDE_CONFIG_DIR. */
export function headlessHomeFor(agentId: string = MAIN_AGENT_ID): string {
  return join(homedir(), `.${agentId}-headless`)
}

let preparedHome: string | null = null

/**
 * Build the isolated home once per process: empty mcp.json, config dir with
 * channel plugins disabled + the dangerous-mode prompt pre-acknowledged.
 * Reuses the worker's ensureWorkerCwd (symlinks, credential seeding, trust
 * stamps) so the two headless surfaces cannot drift apart.
 */
export async function ensureHeadlessHome(agentId: string = MAIN_AGENT_ID): Promise<{ home: string; configDir: string; mcpPath: string }> {
  const home = headlessHomeFor(agentId)
  const configDir = join(home, '.claude-config')
  const mcpPath = join(home, '.mcp.json')
  if (preparedHome !== home) {
    const { makeWorkerCtx, ensureWorkerCwd } = await import('../web/agent-worker.js')
    ensureWorkerCwd(makeWorkerCtx(`${agentId}-headless`, home))
    if (!existsSync(mcpPath)) {
      mkdirSync(home, { recursive: true })
      writeFileSync(mcpPath, '{"mcpServers":{}}\n')
    }
    preparedHome = home
  }
  return { home, configDir, mcpPath }
}

/** The AgentSpec runAgent() one-shots run under on this runtime. */
export function headlessWorkerSpec(): AgentSpec {
  return {
    id: MAIN_AGENT_ID,
    dir: headlessHomeFor(MAIN_AGENT_ID),
    role: 'worker',
    model: process.env.MARVEEN_WORKER_MODEL || DEFAULT_AGENT_MODEL,
    runtime: 'claude-headless',
    provider: 'anthropic',
    authMode: 'subscription',
    securityProfile: 'default',
  }
}

// --- long-lived handles (headless "sessions" = resume chains) ----------------

interface HeadlessSession {
  spec: AgentSpec
  sessionId: string | null
  chain: Promise<unknown>
  inFlight: number
  lastResult: RunResult | null
  lastRateLimit: RateLimitInfo | null
  usage: UsageRecord[]
  authFailed: boolean
}

const sessions = new Map<string, HeadlessSession>()

function handleKey(h: AgentHandle): string { return h.sessionRef }

// --- the adapter --------------------------------------------------------------

async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions & { onRateLimit?: (r: RateLimitInfo) => void } = {}): Promise<RunResult> {
  const { configDir, home, mcpPath } = await ensureHeadlessHome(MAIN_AGENT_ID)
  const { getSecret } = await import('../web/vault.js')
  const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
  // The agent's own mcp.json when it has one; else the empty isolated one.
  // Marveen-injected servers (spec.extraMcpServers, e.g. the Telegram bridge)
  // are merged into a per-agent file under the headless home.
  const agentMcp = join(spec.dir, '.mcp.json')
  let mcpConfigPath = spec.dir !== home && existsSync(agentMcp) ? agentMcp : mcpPath
  if (spec.extraMcpServers && Object.keys(spec.extraMcpServers).length) {
    let base: Record<string, unknown> = {}
    try { base = (JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {} } catch { base = {} }
    const merged = join(configDir, `mcp-${spec.id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
    writeFileSync(merged, JSON.stringify({ mcpServers: { ...base, ...spec.extraMcpServers } }, null, 2) + '\n', { mode: 0o600 })
    mcpConfigPath = merged
  }
  const cwd = opts.cwd ?? spec.dir
  const args = buildHeadlessArgs({
    model: spec.model,
    resume: opts.resume,
    disallowedTools: opts.allowTools ? undefined : HEADLESS_DISALLOWED_TOOLS,
    mcpConfigPath,
    strictMcp: true,
  })
  const env = buildHeadlessEnv({
    spec, configDir, oauthToken: resolveFleetOauthToken(), secretLookup,
    base: { ...process.env, ...(opts.env ?? {}) },
  })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS
  const startedAt = Date.now()
  const acc = new ClaudeStreamAccumulator({ onText: opts.onProgress })
  const dump = streamDumper('claude-headless', spec.id)
  let stderrTail = ''
  let timedOut = false

  const exitCode = await new Promise<number | null>((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try {
      // Default stdio = three pipes (typed as never-null streams).
      child = spawn(claudeBin(), args, { cwd, env })
    } catch (err) {
      stderrTail = `spawn failed: ${(err as Error).message}`
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      logger.warn({ agent: spec.id, timeoutMs }, 'claude-headless: run timed out, terminating')
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, KILL_GRACE_MS).unref()
    }, timeoutMs)
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      dump?.(line)
      const ev = acc.push(line)
      if (ev && ev.type === 'rate_limit_event' && opts.onRateLimit) {
        const info = (ev as { rate_limit_info?: RateLimitInfo }).rate_limit_info
        if (info) opts.onRateLimit(info)
      }
    })
    child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000) })
    child.on('error', (err) => { stderrTail += ` spawn error: ${err.message}`; clearTimeout(timer); resolve(null) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    child.stdin.on('error', () => { /* EPIPE when the CLI exits early; the close handler reports it */ })
    child.stdin.end(prompt)
  })

  const summary = acc.summary()
  const result = summaryToRunResult(summary, {
    runtime: 'claude-headless', provider: spec.provider, model: spec.model, timestamp: startedAt, exitCode, stderrTail,
  })
  if (timedOut) {
    const mins = Math.round(timeoutMs / 60000)
    if (opts.timeoutAsError) {
      return { ...result, text: null, blocked: true, reason: `timeout after ${mins}min` }
    }
    // Historical runAgent contract: a human-facing apology as the text.
    return { ...result, text: `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`, blocked: false }
  }
  if (result.blocked) {
    logger.warn({ agent: spec.id, reason: result.reason, exitCode }, 'claude-headless: run blocked/errored (text=null)')
  }
  // Usage sink is best-effort and never fails the run.
  if (result.usage) {
    try {
      const { recordRuntimeUsage } = await import('./usage-sink.js')
      recordRuntimeUsage(spec.id, result.usage, { contentPreview: prompt.slice(0, 200) })
    } catch (err) {
      logger.debug({ err }, 'claude-headless: usage sink unavailable (skipped)')
    }
  }
  return result
}

function summaryAuth(result: RunResult): boolean {
  return !!result.reason && /authentication_failed|Not logged in|Please run \/login|api_error_status=401/i.test(result.reason)
}

export const claudeHeadlessRuntime: AgentRuntime = {
  kind: 'claude-headless',

  capabilities(agent: AgentSpec): RuntimeCapabilities {
    return {
      interactive: false,
      supportsResume: true,
      supportsHooks: 'native',       // settings.json hooks still run in -p mode
      supportsMcp: true,
      supportsChannelsPlugin: false,
      reportsUsage: 'events',
      contextWindow: contextLimitForModel(agent.model),
    }
  },

  async spawn(agent: AgentSpec, opts: { fresh?: boolean } = {}): Promise<AgentHandle> {
    const ref = `headless:${agent.id}:${randomBytes(4).toString('hex')}`
    // A "fresh" spawn drops any earlier chain for this agent; otherwise reuse
    // the newest session id so the conversation continues across restarts.
    let prior: string | null = null
    if (!opts.fresh) {
      for (const [k, s] of sessions) if (s.spec.id === agent.id && s.sessionId) { prior = s.sessionId; sessions.delete(k) }
    }
    sessions.set(ref, { spec: agent, sessionId: prior, chain: Promise.resolve(), inFlight: 0, lastResult: null, lastRateLimit: null, usage: [], authFailed: false })
    return { agentId: agent.id, runtime: 'claude-headless', sessionRef: ref, host: null }
  },

  async send(handle: AgentHandle, prompt: string, _opts: SendOptions = {}): Promise<SendOutcome> {
    const s = sessions.get(handleKey(handle))
    if (!s) throw new Error(`claude-headless: unknown handle ${handle.sessionRef}`)
    s.inFlight++
    const run = s.chain.then(async () => {
      const r = await runOnce(s.spec, prompt, {
        resume: s.sessionId ?? undefined, allowTools: true, timeoutAsError: true,
        onRateLimit: (info) => { s.lastRateLimit = info },
      })
      s.lastResult = r
      if (r.sessionRef) s.sessionId = r.sessionRef
      if (r.usage) s.usage.push(r.usage)
      s.authFailed = r.blocked && summaryAuth(r)
    }).catch((err) => {
      logger.error({ err, agent: s.spec.id }, 'claude-headless: send failed')
    }).finally(() => { s.inFlight-- })
    s.chain = run
    return 'sent'
  },

  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
    return runOnce(agent, prompt, opts)
  },

  async state(handle: AgentHandle): Promise<AgentState> {
    const s = sessions.get(handleKey(handle))
    if (!s) return 'dead'
    if (s.inFlight > 0) return 'busy'
    if (s.authFailed) return 'auth'
    if (s.lastResult?.blocked && /rate_limit|429|usage limit/i.test(s.lastResult.reason ?? '')) return 'blocked'
    return 'idle'
  },

  async stop(handle: AgentHandle): Promise<void> {
    // In-flight child processes finish on their own (bounded by timeout);
    // the chain simply stops accepting new prompts.
    sessions.delete(handleKey(handle))
  },

  async usageSince(handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }> {
    const s = sessions.get(handleKey(handle))
    const from = typeof cursor?.value === 'number' ? cursor.value : 0
    const all = s?.usage ?? []
    return { records: all.slice(from), cursor: { value: all.length } }
  },

  async healthProbe(agent: AgentSpec): Promise<HealthProbeResult> {
    const r = await runOnce(
      { ...agent, model: agent.provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : agent.model },
      'Reply with exactly: OK',
      { timeoutMs: 90_000, timeoutAsError: true, allowTools: false },
    )
    if (r.text && /\bOK\b/.test(r.text)) return { ok: true, detail: `answered on ${r.usage?.model ?? agent.model}` }
    return { ok: false, detail: r.reason ?? `unexpected reply: ${(r.text ?? '').slice(0, 80)}` }
  },
}

/** Exposed for the adapter's auth-state tests. */
export { streamShowsAuthFailure }

export default claudeHeadlessRuntime
