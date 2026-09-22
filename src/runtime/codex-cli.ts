// `codex-cli` runtime adapter (Phase 2): OpenAI Codex CLI in non-interactive
// mode, for ChatGPT-subscription logins (codex login --device-auth) or an
// OpenAI API key (CODEX_API_KEY from the vault).
//
//   codex exec --json --skip-git-repo-check -m <model> -C <dir> -s <sandbox> \
//        -c approval_policy="never" [--dangerously-bypass-hook-trust] -      (prompt on stdin)
//   codex exec --json ... resume <thread_id> -                               (continue a thread)
//
// Per-agent isolation: CODEX_HOME=<agent dir>/.codex holds the generated
// config.toml (model, sandbox, MCP servers, hooks feature, project trust) and
// the login (auth.json seeded from ~/.codex/auth.json). AGENTS.md and
// .codex/hooks.json are rendered from the agent's CLAUDE.md/SOUL.md and
// .claude/settings.json by bundle-render.ts, so the governance hooks run
// NATIVELY inside Codex through scripts/hooks/shim/codex-hook.mjs.
//
// Verified against codex-cli 0.155.1 `--help` output and the official docs
// (learn.chatgpt.com/docs/*) on 2026-09-22. NOT yet exercised against a live
// login on this host (no ChatGPT login / OpenAI key available) -- see
// docs/agent-agnostic-progress.md for the owner to-do.

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { contextLimitForModel } from '../context-guard.js'
import { lookupProviderSecret } from './secret-ids.js'
import { CodexStreamAccumulator, codexShowsAuthFailure, codexSummaryToRunResult } from './codex-events.js'
import {
  renderCodexConfigToml, renderCodexHooksJson, renderInstructionsMd,
  type ClaudeHooksConfig, type CodexSandboxMode, type McpServerDef,
} from './bundle-render.js'
import type {
  AgentHandle, AgentRuntime, AgentSpec, AgentState, HealthProbeResult, RunOptions, RunResult,
  RuntimeCapabilities, SendOptions, SendOutcome, UsageCursor, UsageRecord,
} from './types.js'

const codexBin = makeLazyBinResolver('codex')
export const DEFAULT_CODEX_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000
const KILL_GRACE_MS = 5_000

// --- pure builders (unit-tested) ---------------------------------------------

export interface CodexArgsOptions {
  model: string
  cwd: string
  sandbox: CodexSandboxMode
  resume?: string
  /** Extra `-c key=value` overrides (TOML values). */
  configOverrides?: string[]
  outputLastMessage?: string
  ephemeral?: boolean
  bypassHookTrust?: boolean
  /** Only when the whole box is already sandboxed; never the default. */
  bypassSandbox?: boolean
}

export function buildCodexArgs(o: CodexArgsOptions): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '-m', o.model, '-C', o.cwd, '-c', 'approval_policy="never"']
  if (o.bypassSandbox) args.push('--dangerously-bypass-approvals-and-sandbox')
  else args.push('-s', o.sandbox)
  if (o.bypassHookTrust) args.push('--dangerously-bypass-hook-trust')
  if (o.ephemeral) args.push('--ephemeral')
  if (o.outputLastMessage) args.push('-o', o.outputLastMessage)
  for (const c of o.configOverrides ?? []) args.push('-c', c)
  if (o.resume) args.push('resume', o.resume)
  // '-' = read the prompt from stdin (never argv).
  args.push('-')
  return args
}

export interface CodexEnvInputs {
  spec: Pick<AgentSpec, 'id' | 'model' | 'provider' | 'authMode'>
  codexHome: string
  secretLookup: (id: string) => string | null
  base?: NodeJS.ProcessEnv
}

/** Child environment: isolated CODEX_HOME; api mode injects CODEX_API_KEY (docs-recommended for non-interactive). */
export function buildCodexEnv(i: CodexEnvInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(i.base ?? process.env), CODEX_HOME: i.codexHome, NO_COLOR: '1' }
  delete env.TELEGRAM_BOT_TOKEN; delete env.SLACK_BOT_TOKEN; delete env.SLACK_APP_TOKEN; delete env.DISCORD_BOT_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY
  if (i.spec.authMode === 'api') {
    const key = lookupProviderSecret('openai', i.spec.id, i.secretLookup)
    if (key) env.CODEX_API_KEY = key.value
  } else {
    delete env.CODEX_API_KEY
  }
  return env
}

/** Sandbox from the Marveen security profile: strict profiles cannot write outside the workspace. */
export function sandboxForProfile(securityProfile: string, permissionMode: 'permissive' | 'strict' | undefined): CodexSandboxMode {
  if (permissionMode === 'strict') return 'read-only'
  if (/^(researcher|marketer|default)$/.test(securityProfile)) return 'workspace-write'
  return 'workspace-write'
}

// --- bundle materialisation (I/O) ------------------------------------------------

export function codexHomeFor(agentDir: string): string {
  return join(agentDir, '.codex')
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, 'utf-8')) as T } catch { return null }
}

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf-8') } catch { return null }
}

export interface PreparedCodexBundle {
  codexHome: string
  configPath: string
  agentsMdPath: string
  hooksPath: string | null
  skippedHooks: string[]
}

/**
 * Render AGENTS.md (only when absent -- an operator-authored one wins),
 * $CODEX_HOME/config.toml (always regenerated: it is derived state) and
 * .codex/hooks.json (from .claude/settings.json hooks), and seed the login.
 */
export function prepareCodexBundle(spec: AgentSpec, opts: { permissionMode?: 'permissive' | 'strict'; hooksEnabled?: boolean } = {}): PreparedCodexBundle {
  const dir = spec.dir
  const codexHome = codexHomeFor(dir)
  mkdirSync(codexHome, { recursive: true })

  // Instructions
  const agentsMdPath = join(dir, 'AGENTS.md')
  if (!existsSync(agentsMdPath)) {
    const md = renderInstructionsMd({
      displayName: spec.displayName,
      claudeMd: readText(join(dir, 'CLAUDE.md')),
      soulMd: readText(join(dir, 'SOUL.md')),
    }, { target: 'AGENTS.md' })
    writeFileSync(agentsMdPath, md)
  }

  // MCP servers: the agent's own .mcp.json (project-scoped), never the host's.
  const mcp = readJson<{ mcpServers?: Record<string, McpServerDef> }>(join(dir, '.mcp.json'))?.mcpServers ?? {}

  // Hooks
  const settings = readJson<{ hooks?: ClaudeHooksConfig }>(join(dir, '.claude', 'settings.json'))
  const hooksEnabled = opts.hooksEnabled ?? true
  let hooksPath: string | null = null
  let skippedHooks: string[] = []
  if (hooksEnabled && settings?.hooks) {
    const shim = `${process.execPath} ${join(PROJECT_ROOT, 'scripts', 'hooks', 'shim', 'codex-hook.mjs')}`
    const r = renderCodexHooksJson(settings.hooks, { shimCommand: shim })
    skippedHooks = r.skipped
    mkdirSync(join(dir, '.codex'), { recursive: true })
    hooksPath = join(dir, '.codex', 'hooks.json')
    writeFileSync(hooksPath, JSON.stringify(r.file, null, 2) + '\n')
  }

  // config.toml
  const configPath = join(codexHome, 'config.toml')
  writeFileSync(configPath, renderCodexConfigToml({
    model: spec.model,
    sandboxMode: sandboxForProfile(spec.securityProfile, opts.permissionMode),
    networkAccess: true,
    approvalPolicy: 'never',
    projectDir: dir,
    hooksEnabled,
    modelContextWindow: undefined,
    mcpServers: mcp,
  }))

  // Login seed: subscription auth lives in ~/.codex/auth.json (codex login);
  // link it into the isolated home so every agent shares the owner's login
  // without copying the token around. api mode uses CODEX_API_KEY instead.
  if (spec.authMode !== 'api') {
    const hostAuth = join(homedir(), '.codex', 'auth.json')
    const link = join(codexHome, 'auth.json')
    let exists = false
    try { exists = !!lstatSync(link) } catch { exists = false }
    if (!exists && existsSync(hostAuth)) {
      try { symlinkSync(hostAuth, link) } catch (err) { logger.warn({ err, link }, 'codex-cli: could not link host auth.json') }
    }
  }
  return { codexHome, configPath, agentsMdPath, hooksPath, skippedHooks }
}

// --- sessions (thread ids) ------------------------------------------------------

interface CodexSession {
  spec: AgentSpec
  threadId: string | null
  chain: Promise<unknown>
  inFlight: number
  lastResult: RunResult | null
  usage: UsageRecord[]
  authFailed: boolean
}
const sessions = new Map<string, CodexSession>()

// --- run ---------------------------------------------------------------------------

async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const bundle = prepareCodexBundle(spec)
  const { getSecret } = await import('../web/vault.js')
  const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
  const cwd = opts.cwd ?? spec.dir
  const args = buildCodexArgs({
    model: spec.model,
    cwd,
    sandbox: opts.allowTools === false ? 'read-only' : sandboxForProfile(spec.securityProfile, undefined),
    resume: opts.resume,
    bypassHookTrust: true, // hooks.json is generated by us from the trusted bundle
  })
  const env = buildCodexEnv({ spec, codexHome: bundle.codexHome, secretLookup, base: { ...process.env, ...(opts.env ?? {}) } })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS
  const startedAt = Date.now()
  const acc = new CodexStreamAccumulator({ onText: opts.onProgress })
  let stderrTail = ''
  let timedOut = false

  const exitCode = await new Promise<number | null>((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try { child = spawn(codexBin(), args, { cwd, env }) } catch (err) {
      stderrTail = `spawn failed: ${(err as Error).message}`; resolve(null); return
    }
    const timer = setTimeout(() => {
      timedOut = true
      logger.warn({ agent: spec.id, timeoutMs }, 'codex-cli: run timed out, terminating')
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, KILL_GRACE_MS).unref()
    }, timeoutMs)
    createInterface({ input: child.stdout }).on('line', (line) => { acc.push(line) })
    child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000) })
    child.on('error', (err) => { stderrTail += ` spawn error: ${err.message}`; clearTimeout(timer); resolve(null) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    child.stdin.on('error', () => { /* EPIPE on early exit; close handler reports */ })
    child.stdin.end(prompt)
  })

  const summary = acc.summary()
  let result = codexSummaryToRunResult(summary, { runtime: 'codex-cli', provider: spec.provider, model: spec.model, timestamp: startedAt, exitCode, stderrTail })
  if (timedOut) {
    const mins = Math.round(timeoutMs / 60000)
    result = opts.timeoutAsError
      ? { ...result, text: null, blocked: true, reason: `timeout after ${mins}min` }
      : { ...result, text: `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`, blocked: false }
  }
  if (result.blocked) {
    logger.warn({ agent: spec.id, reason: result.reason, exitCode, auth: codexShowsAuthFailure(summary) }, 'codex-cli: run blocked/errored (text=null)')
  }
  if (result.usage && !result.blocked) {
    try {
      const { recordRuntimeUsage } = await import('./usage-sink.js')
      recordRuntimeUsage(spec.id, result.usage, { contentPreview: prompt.slice(0, 200) })
    } catch (err) { logger.debug({ err }, 'codex-cli: usage sink unavailable (skipped)') }
  }
  return result
}

export const codexCliRuntime: AgentRuntime = {
  kind: 'codex-cli',

  capabilities(agent: AgentSpec): RuntimeCapabilities {
    return {
      interactive: false,
      supportsResume: true,
      supportsHooks: 'native',   // via .codex/hooks.json + shim ([features] hooks = true)
      supportsMcp: true,
      supportsChannelsPlugin: false,
      reportsUsage: 'events',
      contextWindow: contextLimitForModel(agent.model),
    }
  },

  async spawn(agent: AgentSpec, opts: { fresh?: boolean } = {}): Promise<AgentHandle> {
    const ref = `codex:${agent.id}:${randomBytes(4).toString('hex')}`
    let prior: string | null = null
    if (!opts.fresh) for (const [k, s] of sessions) if (s.spec.id === agent.id && s.threadId) { prior = s.threadId; sessions.delete(k) }
    prepareCodexBundle(agent)
    sessions.set(ref, { spec: agent, threadId: prior, chain: Promise.resolve(), inFlight: 0, lastResult: null, usage: [], authFailed: false })
    return { agentId: agent.id, runtime: 'codex-cli', sessionRef: ref, host: null }
  },

  async send(handle: AgentHandle, prompt: string, _opts: SendOptions = {}): Promise<SendOutcome> {
    const s = sessions.get(handle.sessionRef)
    if (!s) throw new Error(`codex-cli: unknown handle ${handle.sessionRef}`)
    s.inFlight++
    const run = s.chain.then(async () => {
      const r = await runOnce(s.spec, prompt, { resume: s.threadId ?? undefined, allowTools: true, timeoutAsError: true })
      s.lastResult = r
      if (r.sessionRef) s.threadId = r.sessionRef
      if (r.usage && !r.blocked) s.usage.push(r.usage)
      s.authFailed = r.blocked && /401|Unauthorized|Missing bearer|not logged in/i.test(r.reason ?? '')
    }).catch((err) => { logger.error({ err, agent: s.spec.id }, 'codex-cli: send failed') })
      .finally(() => { s.inFlight-- })
    s.chain = run
    return 'sent'
  },

  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
    return runOnce(agent, prompt, opts)
  },

  async state(handle: AgentHandle): Promise<AgentState> {
    const s = sessions.get(handle.sessionRef)
    if (!s) return 'dead'
    if (s.inFlight > 0) return 'busy'
    if (s.authFailed) return 'auth'
    if (s.lastResult?.blocked && /429|rate limit|usage limit|quota/i.test(s.lastResult.reason ?? '')) return 'blocked'
    return 'idle'
  },

  async stop(handle: AgentHandle): Promise<void> { sessions.delete(handle.sessionRef) },

  async usageSince(handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }> {
    const all = sessions.get(handle.sessionRef)?.usage ?? []
    const from = typeof cursor?.value === 'number' ? cursor.value : 0
    return { records: all.slice(from), cursor: { value: all.length } }
  },

  // Cheap probe: no tokens spent. `codex login status` prints "Not logged in"
  // (exit 1) or the logged-in account. API mode: key presence in the vault.
  async healthProbe(agent: AgentSpec): Promise<HealthProbeResult> {
    let version = ''
    try { version = execFileSync(codexBin(), ['--version'], { encoding: 'utf-8', timeout: 15_000 }).trim() } catch (err) {
      return { ok: false, detail: `codex not runnable: ${(err as Error).message}` }
    }
    if (agent.authMode === 'api') {
      const { getSecret } = await import('../web/vault.js')
      const key = lookupProviderSecret('openai', agent.id, (id) => { try { return getSecret(id) } catch { return null } })
      return key ? { ok: true, detail: `${version}; api key from vault (${key.id})` } : { ok: false, detail: `${version}; no OpenAI key in vault (expected OPENAI_API_KEY / provider:openai:api-key)` }
    }
    const bundle = prepareCodexBundle(agent)
    try {
      const out = execFileSync(codexBin(), ['login', 'status'], { encoding: 'utf-8', timeout: 15_000, env: { ...process.env, CODEX_HOME: bundle.codexHome } }).trim()
      return /not logged in/i.test(out) ? { ok: false, detail: `${version}; ${out} (run: codex login --device-auth)` } : { ok: true, detail: `${version}; ${out}` }
    } catch (err) {
      const msg = ((err as { stdout?: string }).stdout ?? (err as Error).message ?? '').toString().trim()
      return { ok: false, detail: `${version}; ${msg || 'login status failed'} (run: codex login --device-auth)` }
    }
  },
}

export default codexCliRuntime
