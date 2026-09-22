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
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, resolve, isAbsolute, join } from 'node:path'
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

function absPath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s
}

/**
 * Wrap a tool body with permission + hook gates. A blocked call returns an
 * error STRING to the model (so it can adapt) rather than throwing the whole
 * run away -- exactly how Claude Code surfaces a denied tool.
 */
export async function gated<T>(
  ctx: ToolContext,
  name: string,
  permissionArg: string | null,
  input: unknown,
  body: () => Promise<T>,
): Promise<T | string> {
  const perm = checkPermission(ctx.permissions, name, permissionArg)
  if (!perm.allowed) {
    ctx.onCall?.({ name, input, ok: false, error: perm.reason })
    return `ERROR: ${name} blocked by permissions -- ${perm.reason}`
  }
  const pre = await ctx.policy.preToolUse(name, input)
  if (!pre.allowed) {
    ctx.onCall?.({ name, input, ok: false, error: pre.reason })
    return `ERROR: ${name} blocked by governance hook -- ${pre.reason ?? 'denied'}`
  }
  const effectiveInput = pre.updatedInput !== undefined ? pre.updatedInput : input
  try {
    const out = await body()
    ctx.onCall?.({ name, input: effectiveInput, ok: true })
    void ctx.policy.postToolUse(name, effectiveInput, out).catch(() => { /* logged inside */ })
    return out
  } catch (err) {
    const msg = (err as Error).message
    ctx.onCall?.({ name, input: effectiveInput, ok: false, error: msg })
    return `ERROR: ${name} failed -- ${msg}`
  }
}

export function builtinTools(ctx: ToolContext): ToolSet {
  const maxOut = ctx.maxOutputChars ?? MAX_OUT
  return {
    Read: tool({
      description: 'Read a UTF-8 text file. Returns its content (truncated when very large).',
      inputSchema: z.object({ file_path: z.string().describe('Absolute path, or relative to the working directory') }),
      execute: async (input) => gated(ctx, 'Read', absPath(ctx.cwd, input.file_path), input, async () => {
        const p = absPath(ctx.cwd, input.file_path)
        return clip(readFileSync(p, 'utf-8'), maxOut)
      }),
    }),
    Write: tool({
      description: 'Create or overwrite a UTF-8 text file (parent directories are created).',
      inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      execute: async (input) => gated(ctx, 'Write', absPath(ctx.cwd, input.file_path), input, async () => {
        const p = absPath(ctx.cwd, input.file_path)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, input.content)
        return `wrote ${input.content.length} chars to ${p}`
      }),
    }),
    Edit: tool({
      description: 'Replace an exact substring in a file (first occurrence unless replace_all).',
      inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
      execute: async (input) => gated(ctx, 'Edit', absPath(ctx.cwd, input.file_path), input, async () => {
        const p = absPath(ctx.cwd, input.file_path)
        const src = readFileSync(p, 'utf-8')
        if (!src.includes(input.old_string)) throw new Error('old_string not found in file')
        const next = input.replace_all ? src.split(input.old_string).join(input.new_string) : src.replace(input.old_string, input.new_string)
        writeFileSync(p, next)
        return `edited ${p}`
      }),
    }),
    Bash: tool({
      description: 'Run a shell command in the working directory and return stdout+stderr (with exit code).',
      inputSchema: z.object({ command: z.string(), timeout_ms: z.number().int().positive().max(600_000).optional() }),
      execute: async (input) => gated(ctx, 'Bash', input.command, input, () => new Promise<string>((resolveP) => {
        const timeout = Math.min(input.timeout_ms ?? ctx.bashTimeoutMs ?? 120_000, 600_000)
        execFile('/bin/bash', ['-lc', input.command], { cwd: ctx.cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, MARVEEN_TOOL_RUNTIME: 'native-api' } }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
          const killed = !!(err && (err as { killed?: boolean }).killed)
          resolveP(clip(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}\n[exit ${code}${killed ? ', killed (timeout)' : ''}]`, maxOut))
        })
      })),
    }),
    ListDir: tool({
      description: 'List directory entries (name, kind, size) -- a lightweight Glob substitute.',
      inputSchema: z.object({ path: z.string().optional() }),
      // Trailing slash: `Read(<dir>/**)` must cover listing <dir> itself.
      execute: async (input) => gated(ctx, 'Read', absPath(ctx.cwd, input.path ?? '.') + '/', input, async () => {
        const p = absPath(ctx.cwd, input.path ?? '.')
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
      execute: async (input) => gated(ctx, 'WebFetch', input.url, input, async () => {
        const ac = new AbortController()
        const t = setTimeout(() => ac.abort(), ctx.webFetchTimeoutMs ?? 30_000)
        try {
          const res = await fetch(input.url, { signal: ac.signal, headers: { 'user-agent': 'Marveen/agent (+native-api)' }, redirect: 'follow' })
          const body = await res.text()
          return clip(`[HTTP ${res.status} ${res.headers.get('content-type') ?? ''}]\n${body}`, maxOut)
        } finally { clearTimeout(t) }
      }),
    }),
  }
}

/** Tools available for pure text generation (runAgent-style, allowTools=false): read-only, no side effects. */
export function readOnlyToolNames(): string[] {
  return ['Read', 'ListDir']
}
