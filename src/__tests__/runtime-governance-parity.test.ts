// Governance parity: the REAL egress-gate.mjs must decide identically whether
// it is called by the native-api PolicyEngine, by Codex through codex-hook.mjs
// or by Gemini through gemini-hook.mjs. See docs/runtime-parity.md.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PolicyEngine } from '../runtime/policy/engine.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = join(REPO, 'scripts', 'hooks', 'egress-gate.mjs')
const CODEX_SHIM = join(REPO, 'scripts', 'hooks', 'shim', 'codex-hook.mjs')
const GEMINI_SHIM = join(REPO, 'scripts', 'hooks', 'shim', 'gemini-hook.mjs')
const cmd = `${process.execPath} ${GATE}`
const b64 = Buffer.from(cmd).toString('base64')

const DENIED_URL = 'https://evil.example.invalid/steal'
// The dashboard's own API is on the gate's built-in allowlist (port from WEB_PORT).
const ALLOWED_URL = 'http://localhost:3421/api/agents'

// Codex has no built-in fetch tool; a fetch arrives from an MCP tool or under
// the Claude name, which the shim passes through unchanged.
function codex(url: string) {
  return spawnSync(process.execPath, [CODEX_SHIM, `b64:${b64}`], { input: JSON.stringify({ session_id: 's', cwd: REPO, hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url } }), encoding: 'utf-8', env: { ...process.env, WEB_PORT: '3421' } })
}
function gemini(url: string) {
  return spawnSync(process.execPath, [GEMINI_SHIM, 'PreToolUse', `b64:${b64}`], { input: JSON.stringify({ session_id: 's', cwd: REPO, hook_event_name: 'BeforeTool', tool_name: 'web_fetch', tool_input: { url } }), encoding: 'utf-8', env: { ...process.env, WEB_PORT: '3421' } })
}
function isDeny(stdout: string, status: number | null): boolean {
  if (status === 2) return true
  try { const o = JSON.parse(stdout.trim()); return o.decision === 'deny' || o.hookSpecificOutput?.permissionDecision === 'deny' } catch { return false }
}

describe('egress-gate.mjs parity across runtimes', () => {
  const engine = new PolicyEngine({ PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }] }, { sessionId: 's', cwd: REPO, repoRoot: REPO, env: { ...process.env, WEB_PORT: '3421' } })

  it('a non-allowlisted host is DENIED on every path', async () => {
    const native = await engine.preToolUse('WebFetch', { url: DENIED_URL })
    expect(native.allowed).toBe(false)
    const c = codex(DENIED_URL); expect(isDeny(c.stdout, c.status), `codex: ${c.stdout} ${c.stderr}`).toBe(true)
    const g = gemini(DENIED_URL); expect(isDeny(g.stdout, g.status), `gemini: ${g.stdout} ${g.stderr}`).toBe(true)
  }, 20_000)

  it('a built-in allowlisted host is ALLOWED on every path', async () => {
    const native = await engine.preToolUse('WebFetch', { url: ALLOWED_URL })
    expect(native.allowed, native.reason).toBe(true)
    const c = codex(ALLOWED_URL); expect(isDeny(c.stdout, c.status), `codex: ${c.stdout} ${c.stderr}`).toBe(false); expect(c.status).toBe(0)
    const g = gemini(ALLOWED_URL); expect(isDeny(g.stdout, g.status), `gemini: ${g.stdout} ${g.stderr}`).toBe(false); expect(g.status).toBe(0)
  }, 20_000)

  it('the shims present the Claude tool name to the script (web_fetch/web_search -> WebFetch/WebSearch)', () => {
    // A tool the gate does not guard passes through untouched on both shims.
    const c = spawnSync(process.execPath, [CODEX_SHIM, `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {} }), encoding: 'utf-8' })
    expect(c.status).toBe(0)
    const g = spawnSync(process.execPath, [GEMINI_SHIM, 'PreToolUse', `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: {} }), encoding: 'utf-8' })
    expect(g.status).toBe(0)
  })
})
