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

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs'
import { writePrivateFile } from './private-file.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { makeLazyBinResolver } from '../platform.js'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { contextLimitForModel } from '../context-guard.js'
import { lookupProviderSecret } from './secret-ids.js'
import { CodexStreamAccumulator, codexShowsAuthFailure, codexSummaryToRunResult } from './codex-events.js'
import { streamDumper } from './stream-dump.js'
import { runJsonlCli, finalizeRunResult, recordUsageBestEffort, ResumeChainSessions } from './cli-process.js'
import {
  renderCodexConfigToml, renderCodexHooksJson, renderInstructionsMd, type ClaudeHooksConfig, type CodexSandboxMode, type McpServerDef,
} from './bundle-render.js'
import type {
  AgentRuntime, AgentSpec, HealthProbeResult, RunOptions, RunResult, RuntimeCapabilities,
} from './types.js'

const codexBin = makeLazyBinResolver('codex')
export const DEFAULT_CODEX_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000

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

/**
 * Sandbox from the Marveen security profile. Every profile writes only inside
 * its workspace (workspace-write) -- which is what the strict profile's allow
 * list grants (Write/Edit under ${AGENT_DIR}); read-only would leave a strict
 * developer agent unable to do its job. The rest of "strict" (allow-list-only
 * tools) is enforced by the hook shim + PolicyEngine, not by the sandbox. The
 * first version had a dead per-profile branch and a read-only strict branch
 * nothing reached (permissionMode was never set).
 */
export function sandboxForProfile(_securityProfile: string, _permissionMode: 'permissive' | 'strict' | undefined): CodexSandboxMode {
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
  opts = { permissionMode: spec.permissionMode, ...opts }
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
  const mcp = { ...(readJson<{ mcpServers?: Record<string, McpServerDef> }>(join(dir, '.mcp.json'))?.mcpServers ?? {}), ...((spec.extraMcpServers ?? {}) as Record<string, McpServerDef>) }

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
    writePrivateFile(hooksPath, JSON.stringify(r.file, null, 2) + '\n')
  }

  // config.toml
  const configPath = join(codexHome, 'config.toml')
  writePrivateFile(configPath, renderCodexConfigToml({
    model: spec.model,
    sandboxMode: sandboxForProfile(spec.securityProfile, opts.permissionMode),
    networkAccess: true,
    approvalPolicy: 'never',
    projectDir: dir,
    hooksEnabled,
    modelContextWindow: undefined,
    mcpServers: mcp,
  })) // MCP env blocks may carry keys: owner-only

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


// --- run ---------------------------------------------------------------------------

async function runOnce(spec: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
  const bundle = prepareCodexBundle(spec)
  const { getSecret } = await import('../web/vault.js')
  const secretLookup = (id: string): string | null => { try { return getSecret(id) } catch { return null } }
  const cwd = opts.cwd ?? spec.dir
  const args = buildCodexArgs({
    model: spec.model,
    cwd,
    sandbox: opts.allowTools === false ? 'read-only' : sandboxForProfile(spec.securityProfile, spec.permissionMode),
    resume: opts.resume,
    bypassHookTrust: true, // hooks.json is generated by us from the trusted bundle
  })
  const env = buildCodexEnv({ spec, codexHome: bundle.codexHome, secretLookup, base: { ...process.env, ...(opts.env ?? {}) } })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS
  const startedAt = Date.now()
  const acc = new CodexStreamAccumulator({ onText: opts.onProgress })
  const dump = streamDumper('codex-cli', spec.id)
  const out = await runJsonlCli({
    bin: codexBin(), args, cwd, env, stdin: prompt, timeoutMs, signal: opts.signal, label: 'codex-cli', agentId: spec.id,
    onLine: (line) => { dump?.(line); acc.push(line) },
  })
  const summary = acc.summary()
  const result = finalizeRunResult(codexSummaryToRunResult(summary, { runtime: 'codex-cli', provider: spec.provider, model: spec.model, timestamp: startedAt, exitCode: out.exitCode, stderrTail: out.stderrTail }), out, { timeoutMs, timeoutAsError: opts.timeoutAsError })
  if (result.blocked) logger.warn({ agent: spec.id, reason: result.reason, exitCode: out.exitCode, auth: codexShowsAuthFailure(summary) }, 'codex-cli: run blocked/errored (text=null)')
  await recordUsageBestEffort(spec.id, result, prompt, 'codex-cli', spec.provider)
  return result
}

// Long-lived handles = resume chains (shared implementation, cli-process.ts).
const sessions = new ResumeChainSessions('codex-cli', 'codex', (spec, prompt, opts) => runOnce(spec, prompt, opts), (r) => /401|Unauthorized|Missing bearer|not logged in/i.test(r.reason ?? ''), (r) => /429|rate limit|usage limit|quota/i.test(r.reason ?? ''))

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

  spawn: async (agent, opts) => { prepareCodexBundle(agent); return sessions.spawn(agent, opts) },
  send: (handle, prompt, opts) => sessions.send(handle, prompt, opts),

  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
    return runOnce(agent, prompt, opts)
  },

  state: (handle) => sessions.state(handle),
  stop: (handle) => sessions.stop(handle),
  usageSince: (handle, cursor) => sessions.usageSince(handle, cursor),

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
