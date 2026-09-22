// Built-in tools for the native-api runtime (Phase 4).
//
// The same tool vocabulary the fleet's prompts and hooks already know
// (Read/Write/Edit/Bash/WebFetch/Glob-ish list), each call gated twice:
//   1. the agent's Claude-syntax permission list (permissions.ts), and
//   2. the PolicyEngine PreToolUse/PostToolUse hooks (the 29 governance scripts).
// Tool names are exposed to the model in the Claude spelling so hook
// matchers (`Bash|.*send_email.*`, `WebFetch`) apply unchanged.

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, basename, join } from 'node:path'
import { checkPermission, type PermissionSet } from '../permissions.js'
import type { PolicyEngine } from '../policy/engine.js'

export interface ToolContext {
  cwd: string
  permissions: PermissionSet
  policy: PolicyEngine
  /** Records every executed tool call for the RunResult. */
  onCall?: (rec: { name: string; input: unknown; ok: boolean; error?: string }) => void
  bashTimeoutMs?: number
  webFetchTimeoutMs?: number
  maxOutputChars?: number
}

const MAX_OUT = 60_000

export class ToolBlockedError extends Error {
  constructor(public readonly toolName: string, reason: string) {
    super(`${toolName} blocked: ${reason}`)
    this.name = 'ToolBlockedError'
  }
}

/**
 * The path a rule must judge: normalised (`..` collapsed, also on absolute
 * input) and with symlinks resolved -- for a path that does not exist yet, the
 * nearest existing ancestor is resolved and the rest appended. The first
 * version passed absolute paths through verbatim, so
 * `${AGENT_DIR}/../../.env` matched `Read(${AGENT_DIR}/**)` and a symlink in
 * the agent dir pointed anywhere. The SAME resolved path is then used for the
 * file operation, so what was checked is what is touched.
 */
export function resolveToolPath(cwd: string, p: string): string {
  const abs = resolve(cwd, p)
  let head = abs
  const tail: string[] = []
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync(head), ...tail.reverse()) } catch { /* not there yet */ }
    const parent = dirname(head)
    if (parent === head) break
    tail.push(basename(head))
    head = parent
  }
  return abs
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s
}

/**
 * Wrap a tool body with permission + hook gates. A blocked call returns an
 * error STRING to the model (so it can adapt) rather than throwing the whole
 * run away -- exactly how Claude Code surfaces a denied tool.
 *
 * The body runs on the EFFECTIVE input: a PreToolUse hook may rewrite it
 * (updatedInput), and the rewrite is re-checked against the permission list
 * before it runs. The first version logged the rewrite and executed the
 * original input.
 */
export async function gated<I, T>(
  ctx: ToolContext,
  name: string,
  permissionArg: (input: I) => string | null,
  input: I,
  body: (input: I) => Promise<T>,
): Promise<T | string> {
  const perm = checkPermission(ctx.permissions, name, permissionArg(input))
  if (!perm.allowed) {
    ctx.onCall?.({ name, input, ok: false, error: perm.reason })
    return `ERROR: ${name} blocked by permissions -- ${perm.reason}`
  }
  const pre = await ctx.policy.preToolUse(name, input)
  if (!pre.allowed) {
    ctx.onCall?.({ name, input, ok: false, error: pre.reason })
    return `ERROR: ${name} blocked by governance hook -- ${pre.reason ?? 'denied'}`
  }
  let effectiveInput = input
  if (pre.updatedInput !== undefined && pre.updatedInput !== null && typeof pre.updatedInput === 'object') {
    effectiveInput = { ...(input as object), ...(pre.updatedInput as object) } as I
    const again = checkPermission(ctx.permissions, name, permissionArg(effectiveInput))
    if (!again.allowed) {
      ctx.onCall?.({ name, input: effectiveInput, ok: false, error: again.reason })
      return `ERROR: ${name} blocked by permissions (after hook rewrite) -- ${again.reason}`
    }
  }
  try {
    const out = await body(effectiveInput)
    ctx.onCall?.({ name, input: effectiveInput, ok: true })
    // Awaited: PostToolUse context (e.g. a notice about fetched content) goes
    // back with the result, as in Claude Code, instead of being dropped.
    let post: Awaited<ReturnType<PolicyEngine['postToolUse']>> | null = null
    try { post = await ctx.policy.postToolUse(name, effectiveInput, out) } catch { post = null }
    if (post && post.additionalContext.length && typeof out === 'string') {
      return `${out}\n\n[hook]\n${post.additionalContext.join('\n')}` as T
    }
    return out
  } catch (err) {
    const msg = (err as Error).message
    ctx.onCall?.({ name, input: effectiveInput, ok: false, error: msg })
    return `ERROR: ${name} failed -- ${msg}`
  }
}

/**
 * Environment for the Bash tool: an allowlist, not the dashboard's whole
 * process.env (which may carry tokens a command could echo or send).
 */
export function bashToolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'TMPDIR', 'PWD', 'NODE_OPTIONS']
  const env: NodeJS.ProcessEnv = {}
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k]
  for (const [k, v] of Object.entries(base)) if (k.startsWith('LC_')) env[k] = v
  env.MARVEEN_TOOL_RUNTIME = 'native-api'
  return env
}

/** Run a command in its own process group; a timeout kills the whole group. */
function runBash(command: string, cwd: string, timeoutMs: number): Promise<{ out: string; code: number | null; killed: boolean }> {
  return new Promise((resolveP) => {
    const child = spawn('/bin/bash', ['-lc', command], { cwd, env: bashToolEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let killed = false; let settled = false
    const LIMIT = 16 * 1024 * 1024
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < LIMIT) stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < LIMIT) stderr += d.toString() })
    const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig) } catch { /* gone */ } }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(hard)
      resolveP({ out: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`, code, killed })
    }
    const timer = setTimeout(() => { killed = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref() }, timeoutMs)
    // A grandchild holding the pipe can keep 'close' from ever firing: resolve on
    // 'exit' plus a grace period, then give up on the streams.
    const hard = setTimeout(() => finish(null), timeoutMs + 10_000)
    child.on('error', (err) => { stderr += `spawn error: ${err.message}`; finish(null) })
    child.on('exit', (code) => { setTimeout(() => finish(code), 200).unref() })
    child.on('close', (code) => finish(code))
  })
}

/** WebFetch redirects are followed by hand so every hop passes the same gates. */
const MAX_REDIRECTS = 5

export function builtinTools(ctx: ToolContext): ToolSet {
  const maxOut = ctx.maxOutputChars ?? MAX_OUT
  return {
    Read: tool({
      description: 'Read a UTF-8 text file. Returns its content (truncated when very large).',
      inputSchema: z.object({ file_path: z.string().describe('Absolute path, or relative to the working directory') }),
      execute: async (input) => gated(ctx, 'Read', (i) => resolveToolPath(ctx.cwd, i.file_path), input, async (i) => {
        const p = resolveToolPath(ctx.cwd, i.file_path)
        return clip(readFileSync(p, 'utf-8'), maxOut)
      }),
    }),
    Write: tool({
      description: 'Create or overwrite a UTF-8 text file (parent directories are created).',
      inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      execute: async (input) => gated(ctx, 'Write', (i) => resolveToolPath(ctx.cwd, i.file_path), input, async (i) => {
        const p = resolveToolPath(ctx.cwd, i.file_path)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, i.content)
        return `wrote ${i.content.length} chars to ${p}`
      }),
    }),
    Edit: tool({
      description: 'Replace an exact substring in a file (first occurrence unless replace_all).',
      inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
      execute: async (input) => gated(ctx, 'Edit', (i) => resolveToolPath(ctx.cwd, i.file_path), input, async (i) => {
        const p = resolveToolPath(ctx.cwd, i.file_path)
        const src = readFileSync(p, 'utf-8')
        if (!src.includes(i.old_string)) throw new Error('old_string not found in file')
        const next = i.replace_all ? src.split(i.old_string).join(i.new_string) : src.replace(i.old_string, i.new_string)
        writeFileSync(p, next)
        return `edited ${p}`
      }),
    }),
    Bash: tool({
      description: 'Run a shell command in the working directory and return stdout+stderr (with exit code).',
      inputSchema: z.object({ command: z.string(), timeout_ms: z.number().int().positive().max(600_000).optional() }),
      execute: async (input) => gated(ctx, 'Bash', (i) => i.command, input, async (i) => {
        const timeout = Math.min(i.timeout_ms ?? ctx.bashTimeoutMs ?? 120_000, 600_000)
        const r = await runBash(i.command, ctx.cwd, timeout)
        return clip(`${r.out}\n[exit ${r.code ?? '?'}${r.killed ? ', killed (timeout)' : ''}]`, maxOut)
      }),
    }),
    ListDir: tool({
      description: 'List directory entries (name, kind, size) -- a lightweight Glob substitute.',
      inputSchema: z.object({ path: z.string().optional() }),
      // Trailing slash: `Read(<dir>/**)` must cover listing <dir> itself.
      execute: async (input) => gated(ctx, 'Read', (i) => resolveToolPath(ctx.cwd, i.path ?? '.') + '/', input, async (i) => {
        const p = resolveToolPath(ctx.cwd, i.path ?? '.')
        if (!existsSync(p)) throw new Error(`no such directory: ${p}`)
        const rows = readdirSync(p).slice(0, 500).map((n) => {
          try { const st = statSync(join(p, n)); return `${st.isDirectory() ? 'd' : 'f'} ${st.size}\t${n}` } catch { return `? ?\t${n}` }
        })
        return rows.join('\n') || '(empty)'
      }),
    }),
    WebFetch: tool({
      description: 'HTTP GET a URL and return the response body as text (HTML is returned raw). Only allow-listed hosts pass the egress gate.',
      inputSchema: z.object({ url: z.string().url(), prompt: z.string().optional().describe('Ignored; kept for Claude Code compatibility') }),
      execute: async (input) => gated(ctx, 'WebFetch', (i) => i.url, input, async (i) => {
        const ac = new AbortController()
        const t = setTimeout(() => ac.abort(), ctx.webFetchTimeoutMs ?? 30_000)
        try {
          let url = i.url
          for (let hop = 0; ; hop++) {
            const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'Marveen/agent (+native-api)' }, redirect: 'manual' })
            const loc = res.headers.get('location')
            if (res.status >= 300 && res.status < 400 && loc) {
              if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
              const next = new URL(loc, url).toString()
              // An open redirect on an allowed host must not reach a denied one:
              // each hop goes through the permission list and the egress hooks.
              const perm = checkPermission(ctx.permissions, 'WebFetch', next)
              if (!perm.allowed) throw new Error(`redirect to ${next} blocked by permissions -- ${perm.reason}`)
              const pre = await ctx.policy.preToolUse('WebFetch', { ...i, url: next })
              if (!pre.allowed) throw new Error(`redirect to ${next} blocked by governance hook -- ${pre.reason ?? 'denied'}`)
              url = next
              continue
            }
            const body = await res.text()
            return clip(`[HTTP ${res.status} ${res.headers.get('content-type') ?? ''}${url !== i.url ? ` via ${url}` : ''}]\n${body}`, maxOut)
          }
        } finally { clearTimeout(t) }
      }),
    }),
  }
}

/** Tools available for pure text generation (runAgent-style, allowTools=false): read-only, no side effects. */
export function readOnlyToolNames(): string[] {
  return ['Read', 'ListDir']
}
