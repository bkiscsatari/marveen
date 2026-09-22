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

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { writePrivateFile } from './private-file.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'
import { PROJECT_ROOT, SERVICE_ID } from '../config.js'
import { contextLimitForModel } from '../context-guard.js'
import { lookupProviderSecret } from './secret-ids.js'
import { MinimaxStreamAccumulator, minimaxShowsAuthFailure, minimaxSummaryToRunResult } from './minimax-events.js'
import { renderInstructionsMd, type ClaudeHooksConfig, type McpServerDef } from './bundle-render.js'
import { streamDumper } from './stream-dump.js'
import { runJsonlCli, finalizeRunResult, recordUsageBestEffort, ResumeChainSessions } from './cli-process.js'
import type {
  AgentRuntime, AgentSpec, HealthProbeResult, RunOptions, RunResult, RuntimeCapabilities,
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
export function renderClaudePluginForHooks(
  pluginName: string,
  claudeHooks: ClaudeHooksConfig | null | undefined,
  opts: { description?: string; scope?: { agentDir: string; wrapperPath: string; node?: string } } = {},
): ClaudePluginFiles {
  const hooks: ClaudeHooksConfig = {}
  const skipped: string[] = []
  // mcode runs EVERY installed local plugin for every run on the host, so a
  // plugin is scoped to its agent by wrapping each command (scope-hook.mjs).
  const wrap = (cmd: string): string => {
    if (!opts.scope) return cmd
    const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')
    return `${opts.scope.node ?? process.execPath} ${opts.scope.wrapperPath} b64:${b64(opts.scope.agentDir)} b64:${b64(cmd)}`
  }
  for (const [event, groups] of Object.entries(claudeHooks ?? {})) {
    for (const g of groups ?? []) {
      const cmds = (g.hooks ?? []).filter((h) => h.type === 'command' && h.command)
      for (const h of g.hooks ?? []) if (h.type !== 'command') skipped.push(`${event}: ${h.type ?? 'unknown'}-type hook has no plugin equivalent`)
      if (!cmds.length) continue
      ;(hooks[event] ??= []).push({ ...(g.matcher ? { matcher: g.matcher } : {}), hooks: cmds.map((h) => ({ type: 'command', command: wrap(h.command!), ...(h.timeout ? { timeout: h.timeout } : {}) })) })
    }
  }
  const manifest = { name: pluginName, version: '1.0.0', description: opts.description ?? 'Marveen governance hooks (generated from .claude/settings.json)', author: { name: 'Marveen' } }
  return { manifest, hooks: Object.keys(hooks).length ? { hooks } : null, skipped }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** `marveen-hooks-<install>-<agent>`; without an install tag the pre-2026-09-23 legacy name. */
export function pluginNameFor(agentId: string, installTag?: string): string {
  return installTag ? `marveen-hooks-${slug(installTag)}-${slug(agentId)}` : `marveen-hooks-${slug(agentId)}`
}

/**
 * Remove the agent's legacy (unscoped, agent-only-named) plugin -- but ONLY
 * when it was rendered by THIS install (its hooks point into this install's
 * scripts/hooks/). Another install's plugin of the same name is left alone.
 */
export function removeOwnLegacyPlugin(legacyName: string, projectRoot: string, dataDir: string = minimaxDataDir()): boolean {
  const dir = join(dataDir, 'plugins', legacyName)
  const hooksFile = join(dir, 'hooks', 'hooks.json')
  const body = readText(hooksFile)
  if (!body) return false
  const mine = body.includes(`${projectRoot}/scripts/hooks/`) || body.includes(`${projectRoot}/scripts/`)
  if (!mine) return false
  try { rmSync(dir, { recursive: true, force: true }); logger.info({ plugin: legacyName }, 'minimax-cli: removed this install\'s legacy unscoped hooks plugin'); return true }
  catch (err) { logger.warn({ err, plugin: legacyName }, 'minimax-cli: could not remove legacy hooks plugin'); return false }
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
  opts = { permissionMode: spec.permissionMode, ...opts }
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
    if (changed) writePrivateFile(mcpPath, JSON.stringify({ mcpServers: merged }, null, 2) + '\n')
  }

  // Hooks plugin.
  let pluginDir: string | null = null
  let pluginName: string | null = null
  let skippedHooks: string[] = []
  const settings = readJson<{ hooks?: ClaudeHooksConfig }>(join(dir, '.claude', 'settings.json'))
  if ((opts.hooksEnabled ?? true) && settings?.hooks) {
    // Named per INSTALL + agent: the plugin directory is shared by every
    // install on the host (the dev clone and the live fleet use the same
    // ~/.minimax), and an agent-only name let a clone run overwrite the live
    // agent's hooks with the clone's paths.
    const legacyName = pluginNameFor(spec.id)
    pluginName = pluginNameFor(spec.id, SERVICE_ID)
    const r = renderClaudePluginForHooks(pluginName, settings.hooks, {
      scope: { agentDir: dir, wrapperPath: join(PROJECT_ROOT, 'scripts', 'hooks', 'shim', 'scope-hook.mjs') },
    })
    skippedHooks = r.skipped
    if (r.hooks) {
      pluginDir = join(minimaxDataDir(), 'plugins', pluginName)
      mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
      mkdirSync(join(pluginDir, 'hooks'), { recursive: true })
      writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(r.manifest, null, 2) + '\n')
      writeFileSync(join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify(r.hooks, null, 2) + '\n')
      if (opts.installPlugin ?? true) ensurePluginInstalled(pluginName)
    }
    // After the scoped plugin is in place, so the agent is never without hooks.
    removeOwnLegacyPlugin(legacyName, PROJECT_ROOT)
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


async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions & { continueLatest?: boolean } = {}): Promise<RunResult> {
  const bundle = prepareMinimaxBundle(spec)
  const { getSecret } = await import('../web/vault.js')
  const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
  const cwd = opts.cwd ?? spec.dir
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MINIMAX_TIMEOUT_MS
  const args = buildMinimaxArgs({ model: spec.model, cwd, permission: permissionForProfile(spec.permissionMode, opts.allowTools), resume: opts.resume, continueLatest: opts.continueLatest, configPath: bundle.configPath, timeoutMs, maxSteps: Number(process.env.MARVEEN_MINIMAX_MAX_STEPS) || 60 })
  const env = buildMinimaxEnv({ spec, dataDir: minimaxDataDir(), secretLookup, base: { ...process.env, ...(opts.env ?? {}) } })
  const startedAt = Date.now()
  const acc = new MinimaxStreamAccumulator({ onText: opts.onProgress })
  const dump = streamDumper('minimax-cli', spec.id)
  const out = await runJsonlCli({
    // mcode's own --timeout ends the run first; ours is the backstop.
    bin: mcodeBin(), args, cwd, env, stdin: prompt, timeoutMs: timeoutMs + KILL_GRACE_MS, signal: opts.signal, label: 'minimax-cli', agentId: spec.id,
    onLine: (line) => { dump?.(line); acc.push(line) },
  })
  const summary = acc.summary()
  const result = finalizeRunResult(minimaxSummaryToRunResult(summary, { runtime: 'minimax-cli', provider: spec.provider, model: spec.model, timestamp: startedAt, exitCode: out.exitCode, stderrTail: out.stderrTail }), out, { timeoutMs, timeoutAsError: opts.timeoutAsError })
  if (result.blocked) logger.warn({ agent: spec.id, reason: result.reason, exitCode: out.exitCode, auth: minimaxShowsAuthFailure(summary, out.stderrTail, out.exitCode) }, 'minimax-cli: run blocked/errored (text=null)')
  await recordUsageBestEffort(spec.id, result, prompt, 'minimax-cli', spec.provider)
  return result
}

// Long-lived handles = resume chains (shared implementation, cli-process.ts).
const sessions = new ResumeChainSessions('minimax-cli', 'minimax', (spec, prompt, opts) => runOnce(spec, prompt, opts), (r) => /not signed in|login|auth|401|exit=3/i.test(r.reason ?? ''), (r) => /429|rate limit|quota|usage limit|insufficient/i.test(r.reason ?? ''))

export const minimaxCliRuntime: AgentRuntime = {
  kind: 'minimax-cli',
  capabilities(agent: AgentSpec): RuntimeCapabilities {
    return { interactive: false, supportsResume: true, supportsHooks: 'native', supportsMcp: true, supportsChannelsPlugin: false, reportsUsage: 'events', contextWindow: contextLimitForModel(agent.model) }
  },
  spawn: async (agent, opts) => { prepareMinimaxBundle(agent); return sessions.spawn(agent, opts) },
  send: (handle, prompt, opts) => sessions.send(handle, prompt, opts),

  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> { return runOnce(agent, prompt, opts) },
  state: (handle) => sessions.state(handle),
  stop: (handle) => sessions.stop(handle),
  usageSince: (handle, cursor) => sessions.usageSince(handle, cursor),

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
