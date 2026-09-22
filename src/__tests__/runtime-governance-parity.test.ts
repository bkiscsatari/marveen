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
  return spawnSync(process.execPath, [GEMINI_SHIM, 'PreToolUse', `b64:${b64}`], { input: JSON.stringify({ session_id: 's', cwd: REPO, hook_event_name: 'BeforeTool', tool_name: 'web_fetch', tool_input: { prompt: `Summarize the page at ${url} in three bullets` } }), encoding: 'utf-8', env: { ...process.env, WEB_PORT: '3421' } })
}
// The REAL Gemini web_fetch input is {prompt} with the URL in the text (gemini-cli 0.60.0,
// WEB_FETCH_PARAM_PROMPT); the first version of this test sent a made-up {url} and so
// hid that the gate answered "no-url" = allow on real traffic.
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

  it('gemini: a prompt with several URLs is denied if ANY of them is; a prompt with none is denied', () => {
    const run = (prompt: string) => spawnSync(process.execPath, [GEMINI_SHIM, 'PreToolUse', `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'web_fetch', tool_input: { prompt } }), encoding: 'utf-8', env: { ...process.env, WEB_PORT: '3421' } })
    const mixed = run(`compare ${ALLOWED_URL} with ${DENIED_URL}`)
    expect(isDeny(mixed.stdout, mixed.status)).toBe(true)
    const none = run('fetch the thing we talked about')
    expect(isDeny(none.stdout, none.status)).toBe(true)
  })

  it('codex: an argv-array shell command reaches the gate as one Claude command string', () => {
    const probe = `${process.execPath} -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);process.exit(/curl/.test(p.tool_input.command)&&typeof p.tool_input.command==='string'?2:0)})"`
    const pb64 = Buffer.from(probe).toString('base64')
    const run = (tool_input: unknown) => spawnSync(process.execPath, [CODEX_SHIM, `b64:${pb64}`], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input }), encoding: 'utf-8' })
    expect(run({ command: ['bash', '-lc', 'curl https://evil.example'] }).status).toBe(2)
    expect(run({ command: ['curl', 'https://evil.example'] }).status).toBe(2)
    expect(run({ cmd: 'curl https://evil.example' }).status).toBe(2)
    expect(run({ command: ['ls', '-la'] }).status).toBe(0)
  })

  it('a crashing security gate blocks through both shims (fail closed)', () => {
    const crash = `${process.execPath} -e "process.exit(1)" # egress-gate.mjs`
    const cb64 = Buffer.from(crash).toString('base64')
    const c = spawnSync(process.execPath, [CODEX_SHIM, `b64:${cb64}`], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: ALLOWED_URL } }), encoding: 'utf-8' })
    expect(c.status).toBe(2)
    const g = spawnSync(process.execPath, [GEMINI_SHIM, 'PreToolUse', `b64:${cb64}`], { input: JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'web_fetch', tool_input: { prompt: ALLOWED_URL } }), encoding: 'utf-8' })
    expect(g.status).toBe(2)
  })

  it('the shims present the Claude tool name to the script (web_fetch/web_search -> WebFetch/WebSearch)', () => {
    // A tool the gate does not guard passes through untouched on both shims.
    const c = spawnSync(process.execPath, [CODEX_SHIM, `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {} }), encoding: 'utf-8' })
    expect(c.status).toBe(0)
    const g = spawnSync(process.execPath, [GEMINI_SHIM, 'PreToolUse', `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: {} }), encoding: 'utf-8' })
    expect(g.status).toBe(0)
  })
})
