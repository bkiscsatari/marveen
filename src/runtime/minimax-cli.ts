// `minimax-cli` runtime adapter (Phase 7): MiniMax Code (`mcode`) in
// non-interactive mode, for a MiniMax SUBSCRIPTION login (`mcode login`,
// device-code flow, stored under $MINIMAX_DATA_DIR = ~/.minimax) or a MiniMax
// API key (`mcode provider set-minimax-key` / MINIMAX_API_KEY).
//
//   mcode exec --input - --output-format stream-json --permission full|smart|off \
//         --model minimax/<Model> --cwd <dir> [--continue | --session <id>] \
//         [--config <yaml>] [--timeout 20m] [--max-steps N]        (prompt on stdin)
//
// Facts (installed 0.5.1 --help + bundle, 2026-09-22): project `.mcp.json` in
// the workspace is loaded natively; AGENTS.md / CLAUDE.md are read as project
// instructions (32 KiB); `--config <path>` gives a per-run Runtime config; a
// CLAUDE-FORMAT plugin (`<dir>/.claude-plugin/plugin.json` + `hooks/hooks.json`)
// dropped into the local marketplace directory ($MINIMAX_DATA_DIR/plugins) is
// loaded with the Claude hook payload (`hook_event_name`, `tool_name`,
// `tool_input`, `tool_use_id`, `transcript_path`, `permission_mode`, …) and
// the Claude reply dialect (`hookSpecificOutput.permissionDecision`,
// `updatedInput`, `additionalContext`, `decision`). So the fleet's
// .claude/settings.json hooks run NATIVELY -- no shim.
//
// Exit codes observed: 0 ok, 3 not signed in.

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'
import { contextLimitForModel } from '../context-guard.js'
import { lookupProviderSecret } from './secret-ids.js'
import { MinimaxStreamAccumulator, minimaxShowsAuthFailure, minimaxSummaryToRunResult } from './minimax-events.js'
import { renderInstructionsMd, type ClaudeHooksConfig, type McpServerDef } from './bundle-render.js'
import { streamDumper } from './stream-dump.js'
import type {
  AgentHandle, AgentRuntime, AgentSpec, AgentState, HealthProbeResult, RunOptions, RunResult,
  RuntimeCapabilities, SendOptions, SendOutcome, UsageCursor, UsageRecord,
} from './types.js'

const mcodeBin = makeLazyBinResolver('mcode')
export const DEFAULT_MINIMAX_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000
const KILL_GRACE_MS = 5_000

export type MinimaxPermission = 'full' | 'smart' | 'off'

// --- pure builders (unit-tested) ---------------------------------------------

/** `minimax-m3` (Marveen id) -> `minimax/MiniMax-M3` (mcode provider/model id). */
export function mcodeModelId(model: string): string {
  const m = model.trim()
  if (m.includes('/')) return m
  let rest = m.replace(/^minimax-/i, '')
  if (/^m\d/i.test(rest)) rest = 'M' + rest.slice(1)          // m3 -> M3, m2.7-highspeed -> M2.7-highspeed
  if (!/^MiniMax-/i.test(rest)) rest = `MiniMax-${rest}`
  return `minimax/${rest.replace(/^minimax-/i, 'MiniMax-')}`
}

export interface MinimaxArgsOptions {
  model: string
  cwd: string
  permission: MinimaxPermission
  resume?: string
  continueLatest?: boolean
  configPath?: string
  timeoutMs?: number
  maxSteps?: number
  outputLastMessage?: string
}

export function buildMinimaxArgs(o: MinimaxArgsOptions): string[] {
  const args = ['exec', '--input', '-', '--output-format', 'stream-json', '--permission', o.permission, '--model', mcodeModelId(o.model), '--cwd', o.cwd]
  if (o.resume) args.push('--session', o.resume)
  else if (o.continueLatest) args.push('--continue')
  if (o.configPath) args.push('--config', o.configPath)
  if (o.timeoutMs) args.push('--timeout', `${Math.max(1, Math.ceil(o.timeoutMs / 1000))}s`)
  if (o.maxSteps) args.push('--max-steps', String(o.maxSteps))
  if (o.outputLastMessage) args.push('-o', o.outputLastMessage)
  return args
}

export interface MinimaxEnvInputs {
  spec: Pick<AgentSpec, 'id' | 'model' | 'provider' | 'authMode'>
  dataDir: string
  secretLookup: (id: string) => string | null
  base?: NodeJS.ProcessEnv
}

/** subscription: rely on the login in $MINIMAX_DATA_DIR; api: MINIMAX_API_KEY from the vault. Foreign secrets stripped. */
export function buildMinimaxEnv(i: MinimaxEnvInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(i.base ?? process.env), MINIMAX_DATA_DIR: i.dataDir, NO_COLOR: '1' }
  delete env.TELEGRAM_BOT_TOKEN; delete env.SLACK_BOT_TOKEN; delete env.SLACK_APP_TOKEN; delete env.DISCORD_BOT_TOKEN
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY; delete env.CODEX_API_KEY; delete env.GEMINI_API_KEY
  if (i.spec.authMode === 'api') {
    const key = lookupProviderSecret('minimax', i.spec.id, i.secretLookup)
    if (key) env.MINIMAX_API_KEY = key.value
  } else {
    delete env.MINIMAX_API_KEY
  }
  return env
}

export function permissionForProfile(permissionMode: 'permissive' | 'strict' | undefined, allowTools: boolean | undefined): MinimaxPermission {
  if (allowTools === false) return 'off'
  if (permissionMode === 'strict') return 'smart'
  return 'full'
}

/** Per-run Runtime config (YAML): model + permission; nothing else is overridden. */
export function renderMinimaxConfigYaml(o: { model: string; permission: MinimaxPermission }): string {
  return [
    '# Generated by Marveen (minimax-cli runtime). Do not edit by hand.',
    `defaultModel: ${mcodeModelId(o.model)}`,
    `permissionMode: ${o.permission === 'full' ? 'auto' : o.permission === 'off' ? 'auto' : 'smart'}`,
    '',
  ].join('\n')
}

export interface ClaudePluginFiles { manifest: Record<string, unknown>; hooks: { hooks: ClaudeHooksConfig } | null; skipped: string[] }

/**
 * A Claude-format plugin carrying the agent's hooks verbatim (mcode reads the
 * Claude hook schema and speaks the Claude payload/reply dialect). Agent-type
 * hooks (PreCompact memory save) have no command equivalent and are skipped.
 */
export function renderClaudePluginForHooks(pluginName: string, claudeHooks: ClaudeHooksConfig | null | undefined, opts: { description?: string } = {}): ClaudePluginFiles {
  const hooks: ClaudeHooksConfig = {}
  const skipped: string[] = []
  for (const [event, groups] of Object.entries(claudeHooks ?? {})) {
    for (const g of groups ?? []) {
      const cmds = (g.hooks ?? []).filter((h) => h.type === 'command' && h.command)
      for (const h of g.hooks ?? []) if (h.type !== 'command') skipped.push(`${event}: ${h.type ?? 'unknown'}-type hook has no plugin equivalent`)
      if (!cmds.length) continue
      ;(hooks[event] ??= []).push({ ...(g.matcher ? { matcher: g.matcher } : {}), hooks: cmds.map((h) => ({ type: 'command', command: h.command!, ...(h.timeout ? { timeout: h.timeout } : {}) })) })
    }
  }
  const manifest = { name: pluginName, version: '1.0.0', description: opts.description ?? 'Marveen governance hooks (generated from .claude/settings.json)', author: { name: 'Marveen' } }
  return { manifest, hooks: Object.keys(hooks).length ? { hooks } : null, skipped }
}

export function minimaxDataDir(): string {
  return process.env.MINIMAX_DATA_DIR?.trim() || join(homedir(), '.minimax')
}

function readJson<T>(p: string): T | null { try { return JSON.parse(readFileSync(p, 'utf-8')) as T } catch { return null } }
function readText(p: string): string | null { try { return readFileSync(p, 'utf-8') } catch { return null } }

export interface PreparedMinimaxBundle { configPath: string; agentsMdPath: string; pluginDir: string | null; pluginName: string | null; skippedHooks: string[]; mcpPath: string | null }

/**
 * AGENTS.md (only when absent), a per-agent Runtime config YAML under
 * <dir>/.minimax/, the merged .mcp.json when extra MCP servers are injected
 * (written to <dir>/.mcp.json ONLY if the agent has none of its own -- the
 * workspace file is what mcode reads), and the hooks plugin in the local
 * marketplace directory, installed/enabled idempotently.
 */
export function prepareMinimaxBundle(spec: AgentSpec, opts: { permissionMode?: 'permissive' | 'strict'; hooksEnabled?: boolean; installPlugin?: boolean } = {}): PreparedMinimaxBundle {
  const dir = spec.dir
  const stateDir = join(dir, '.minimax')
  mkdirSync(stateDir, { recursive: true })
  const agentsMdPath = join(dir, 'AGENTS.md')
  if (!existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, renderInstructionsMd({ displayName: spec.displayName, claudeMd: readText(join(dir, 'CLAUDE.md')), soulMd: readText(join(dir, 'SOUL.md')) }, { target: 'AGENTS.md' }))
  }
  const configPath = join(stateDir, 'runtime-config.yaml')
  writeFileSync(configPath, renderMinimaxConfigYaml({ model: spec.model, permission: permissionForProfile(opts.permissionMode, undefined) }))

  // Extra MCP servers (Telegram bridge): merge into the workspace .mcp.json,
  // which is the only place mcode reads project MCP from.
  let mcpPath: string | null = null
  if (spec.extraMcpServers && Object.keys(spec.extraMcpServers).length) {
    mcpPath = join(dir, '.mcp.json')
    const base = readJson<{ mcpServers?: Record<string, McpServerDef> }>(mcpPath)?.mcpServers ?? {}
    const merged = { ...base }
    let changed = false
    for (const [k, v] of Object.entries(spec.extraMcpServers)) if (JSON.stringify(merged[k]) !== JSON.stringify(v)) { merged[k] = v as McpServerDef; changed = true }
    if (changed) writeFileSync(mcpPath, JSON.stringify({ mcpServers: merged }, null, 2) + '\n')
  }

  // Hooks plugin.
  let pluginDir: string | null = null
  let pluginName: string | null = null
  let skippedHooks: string[] = []
  const settings = readJson<{ hooks?: ClaudeHooksConfig }>(join(dir, '.claude', 'settings.json'))
  if ((opts.hooksEnabled ?? true) && settings?.hooks) {
    pluginName = `marveen-hooks-${spec.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
    const r = renderClaudePluginForHooks(pluginName, settings.hooks)
    skippedHooks = r.skipped
    if (r.hooks) {
      pluginDir = join(minimaxDataDir(), 'plugins', pluginName)
      mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
      mkdirSync(join(pluginDir, 'hooks'), { recursive: true })
      writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(r.manifest, null, 2) + '\n')
      writeFileSync(join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify(r.hooks, null, 2) + '\n')
      if (opts.installPlugin ?? true) ensurePluginInstalled(pluginName)
    }
  }
  return { configPath, agentsMdPath, pluginDir, pluginName, skippedHooks, mcpPath }
}

// A directory under $MINIMAX_DATA_DIR/plugins is discovered as an INSTALLED
// local plugin automatically (measured 2026-09-22: `plugin list -m local`
// reports installed+enabled right after the files are written; `plugin add`
// answers LOCAL_PLUGIN_INSTALL_UNSUPPORTED for the local marketplace). Only an
// explicit enable is needed in case it was disabled earlier.
const enabledPlugins = new Set<string>()
function ensurePluginInstalled(name: string): void {
  if (enabledPlugins.has(name)) return
  try {
    const out = execFileSync(mcodeBin(), ['plugin', 'enable', name, '-m', 'local', '--json'], { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MINIMAX_DATA_DIR: minimaxDataDir() } })
    if (!/"enabled":\s*true/.test(out)) logger.warn({ name, out: out.slice(0, 200) }, 'minimax-cli: plugin not reported enabled (hooks may not run natively)')
  } catch (err) {
    const out = `${(err as { stdout?: string }).stdout ?? ''} ${(err as { stderr?: string }).stderr ?? ''}`
    logger.warn({ name, out: out.slice(0, 200) }, 'minimax-cli: plugin enable failed (hooks may not run natively)')
  }
  enabledPlugins.add(name)
}

interface Session { spec: AgentSpec; sessionId: string | null; chain: Promise<unknown>; inFlight: number; lastResult: RunResult | null; usage: UsageRecord[]; authFailed: boolean }
const sessions = new Map<string, Session>()

async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions & { continueLatest?: boolean } = {}): Promise<RunResult> {
  const bundle = prepareMinimaxBundle(spec)
  const { getSecret } = await import('../web/vault.js')
  const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
  const cwd = opts.cwd ?? spec.dir
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MINIMAX_TIMEOUT_MS
  const args = buildMinimaxArgs({ model: spec.model, cwd, permission: permissionForProfile(undefined, opts.allowTools), resume: opts.resume, continueLatest: opts.continueLatest, configPath: bundle.configPath, timeoutMs, maxSteps: Number(process.env.MARVEEN_MINIMAX_MAX_STEPS) || 60 })
  const env = buildMinimaxEnv({ spec, dataDir: minimaxDataDir(), secretLookup, base: { ...process.env, ...(opts.env ?? {}) } })
  const startedAt = Date.now()
  const acc = new MinimaxStreamAccumulator({ onText: opts.onProgress })
  const dump = streamDumper('minimax-cli', spec.id)
  let stderrTail = ''
  let timedOut = false
  const exitCode = await new Promise<number | null>((resolve) => {
    let child: ChildProcessWithoutNullStreams
    try { child = spawn(mcodeBin(), args, { cwd, env }) } catch (err) { stderrTail = `spawn failed: ${(err as Error).message}`; resolve(null); return }
    const timer = setTimeout(() => {
      timedOut = true
      logger.warn({ agent: spec.id, timeoutMs }, 'minimax-cli: run timed out, terminating')
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, KILL_GRACE_MS).unref()
    }, timeoutMs + KILL_GRACE_MS)
    createInterface({ input: child.stdout }).on('line', (line) => { dump?.(line); acc.push(line) })
    child.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000) })
    child.on('error', (err) => { stderrTail += ` spawn error: ${err.message}`; clearTimeout(timer); resolve(null) })
    child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    child.stdin.on('error', () => { /* EPIPE on early exit */ })
    child.stdin.end(prompt)
  })
  const summary = acc.summary()
  let result = minimaxSummaryToRunResult(summary, { runtime: 'minimax-cli', provider: spec.provider, model: spec.model, timestamp: startedAt, exitCode, stderrTail })
  if (timedOut) {
    const mins = Math.round(timeoutMs / 60000)
    result = opts.timeoutAsError
      ? { ...result, text: null, blocked: true, reason: `timeout after ${mins}min` }
      : { ...result, text: `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`, blocked: false }
  }
  if (result.blocked) logger.warn({ agent: spec.id, reason: result.reason, exitCode, auth: minimaxShowsAuthFailure(summary, stderrTail, exitCode) }, 'minimax-cli: run blocked/errored (text=null)')
  if (result.usage && !result.blocked) {
    try { const { recordRuntimeUsage } = await import('./usage-sink.js'); recordRuntimeUsage(spec.id, result.usage, { contentPreview: prompt.slice(0, 200) }) }
    catch (err) { logger.debug({ err }, 'minimax-cli: usage sink unavailable (skipped)') }
  }
  return result
}

export const minimaxCliRuntime: AgentRuntime = {
  kind: 'minimax-cli',
  capabilities(agent: AgentSpec): RuntimeCapabilities {
    return { interactive: false, supportsResume: true, supportsHooks: 'native', supportsMcp: true, supportsChannelsPlugin: false, reportsUsage: 'events', contextWindow: contextLimitForModel(agent.model) }
  },
  async spawn(agent: AgentSpec, opts: { fresh?: boolean } = {}): Promise<AgentHandle> {
    const ref = `minimax:${agent.id}:${randomBytes(4).toString('hex')}`
    let prior: string | null = null
    if (!opts.fresh) for (const [k, s] of sessions) if (s.spec.id === agent.id && s.sessionId) { prior = s.sessionId; sessions.delete(k) }
    prepareMinimaxBundle(agent)
    sessions.set(ref, { spec: agent, sessionId: prior, chain: Promise.resolve(), inFlight: 0, lastResult: null, usage: [], authFailed: false })
    return { agentId: agent.id, runtime: 'minimax-cli', sessionRef: ref, host: null }
  },
  async send(handle: AgentHandle, prompt: string, _opts: SendOptions = {}): Promise<SendOutcome> {
    const s = sessions.get(handle.sessionRef)
    if (!s) throw new Error(`minimax-cli: unknown handle ${handle.sessionRef}`)
    s.inFlight++
    const run = s.chain.then(async () => {
      const r = await runOnce(s.spec, prompt, { resume: s.sessionId ?? undefined, allowTools: true, timeoutAsError: true })
      s.lastResult = r
      if (r.sessionRef) s.sessionId = r.sessionRef
      if (r.usage && !r.blocked) s.usage.push(r.usage)
      s.authFailed = r.blocked && /auth|Sign in|mcode login|exit=3/i.test(r.reason ?? '')
    }).catch((err) => { logger.error({ err, agent: s.spec.id }, 'minimax-cli: send failed') }).finally(() => { s.inFlight-- })
    s.chain = run
    return 'sent'
  },
  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> { return runOnce(agent, prompt, opts) },
  async state(handle: AgentHandle): Promise<AgentState> {
    const s = sessions.get(handle.sessionRef)
    if (!s) return 'dead'
    if (s.inFlight > 0) return 'busy'
    if (s.authFailed) return 'auth'
    if (s.lastResult?.blocked && /429|rate limit|quota|insufficient/i.test(s.lastResult.reason ?? '')) return 'blocked'
    return 'idle'
  },
  async stop(handle: AgentHandle): Promise<void> { sessions.delete(handle.sessionRef) },
  async usageSince(handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }> {
    const all = sessions.get(handle.sessionRef)?.usage ?? []
    const from = typeof cursor?.value === 'number' ? cursor.value : 0
    return { records: all.slice(from), cursor: { value: all.length } }
  },
  // `mcode provider list` only reports the configured credential SOURCE
  // ("minimax_oauth active" even when logged out -- measured 2026-09-22), so
  // the probe is a real one-step exec: exit 3 / "Sign in to MiniMax" = no login.
  async healthProbe(agent: AgentSpec): Promise<HealthProbeResult> {
    let version = ''
    try { version = execFileSync(mcodeBin(), ['--version'], { encoding: 'utf-8', timeout: 15_000 }).trim() } catch (err) { return { ok: false, detail: `mcode not runnable: ${(err as Error).message}` } }
    if (agent.authMode === 'api') {
      const { getSecret } = await import('../web/vault.js')
      const key = lookupProviderSecret('minimax', agent.id, (id) => { try { return getSecret(id) } catch { return null } })
      if (!key) return { ok: false, detail: `mcode ${version}; no MiniMax key in vault (expected MINIMAX_API_KEY / provider:minimax:api-key)` }
    }
    const r = await runOnce({ ...agent, model: process.env.MARVEEN_MINIMAX_PROBE_MODEL || 'minimax-m2.7-highspeed' }, 'Reply with exactly: OK', { timeoutMs: 90_000, timeoutAsError: true, allowTools: false })
    if (r.text && /\bOK\b/i.test(r.text)) return { ok: true, detail: `mcode ${version}; answered on ${r.usage?.model ?? 'minimax'} (${agent.authMode})` }
    const auth = /exit=3|Sign in to MiniMax|mcode login/i.test(r.reason ?? '')
    return { ok: false, detail: `mcode ${version}; ${auth ? 'not signed in (run: mcode login --region global --no-browser)' : (r.reason ?? 'unexpected reply').slice(0, 200)}` }
  },
}

export default minimaxCliRuntime
