import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildGeminiArgs, buildGeminiEnv, approvalModeForProfile, prepareGeminiBundle, geminiCliRuntime } from '../runtime/gemini-cli.js'
import { renderGeminiSettings, CLAUDE_TO_GEMINI_TOOL, translateMatcher } from '../runtime/bundle-render.js'
import type { AgentSpec } from '../runtime/types.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmp = mkdtempSync(join(tmpdir(), 'marveen-gemini-'))
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('buildGeminiArgs', () => {
  it('headless stream-json with yolo approvals; prompt as its own argv element', () => {
    const hostile = "x'; rm -rf /; echo '"
    const a = buildGeminiArgs({ prompt: hostile, model: 'gemini-2.5-flash', approvalMode: 'yolo' })
    expect(a).toEqual(['-p', hostile, '--output-format', 'stream-json', '--approval-mode', 'yolo', '-m', 'gemini-2.5-flash', '--skip-trust'])
  })
  it('resume latest wins over session id; include-directories and allowed MCP names', () => {
    const a = buildGeminiArgs({ prompt: 'p', model: 'm', approvalMode: 'plan', resumeLatest: true, sessionId: 'x', includeDirectories: ['/a'], allowedMcpServerNames: ['marveen-channel'] })
    expect(a).toContain('-r'); expect(a[a.indexOf('-r') + 1]).toBe('latest')
    expect(a).not.toContain('--session-id')
    expect(a[a.indexOf('--include-directories') + 1]).toBe('/a')
    expect(a[a.indexOf('--allowed-mcp-server-names') + 1]).toBe('marveen-channel')
  })
})

describe('buildGeminiEnv', () => {
  const base = { PATH: '/usr/bin', GEMINI_API_KEY: 'stale', CLAUDE_CODE_OAUTH_TOKEN: 'c', TELEGRAM_BOT_TOKEN: 'leak' }
  it('subscription: NO_BROWSER for headless login, foreign secrets stripped, stale key dropped', () => {
    const env = buildGeminiEnv({ spec: { id: 'a', model: 'gemini-2.5-pro', provider: 'google', authMode: 'subscription' }, secretLookup: () => 'k', base })
    expect(env.NO_BROWSER).toBe('true')
    expect(env.GEMINI_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })
  it('api: GEMINI_API_KEY from the vault (legacy id first)', () => {
    const env = buildGeminiEnv({ spec: { id: 'a', model: 'gemini-2.5-pro', provider: 'google', authMode: 'api' }, secretLookup: (id) => (id === 'GEMINI_API_KEY' ? 'g' : null), base })
    expect(env.GEMINI_API_KEY).toBe('g')
  })
})

describe('approvalModeForProfile', () => {
  it('text-only -> plan; strict -> auto_edit; else yolo', () => {
    expect(approvalModeForProfile(undefined, false)).toBe('plan')
    expect(approvalModeForProfile('strict', true)).toBe('auto_edit')
    expect(approvalModeForProfile('permissive', undefined)).toBe('yolo')
  })
})

describe('renderGeminiSettings', () => {
  const { settings, skipped } = renderGeminiSettings({
    mcpServers: { gmail: { command: 'npx', args: ['-y', 'x'], env: { A: '1' } }, chan: { url: 'http://127.0.0.1:3421/mcp', headers: { Authorization: 'Bearer t' } }, sse: { url: 'http://h/sse', type: 'sse' } },
    claudeHooks: {
      PreToolUse: [{ matcher: 'Bash|WebFetch', hooks: [{ type: 'command', command: 'node /x/gate.mjs', timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 /x/p.py', timeout: 5 }] }],
      PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'echo' }] }],
    },
    shimCommand: '/usr/bin/node /x/shim/gemini-hook.mjs',
    extra: { general: { previewFeatures: false } },
  })
  it('MCP: stdio, streamable HTTP (httpUrl) and SSE (url) forms', () => {
    expect(settings.mcpServers).toEqual({
      gmail: { command: 'npx', args: ['-y', 'x'], env: { A: '1' } },
      chan: { httpUrl: 'http://127.0.0.1:3421/mcp', headers: { Authorization: 'Bearer t' } },
      sse: { url: 'http://h/sse' },
    })
  })
  it('hooks: events + tool names translated, timeout in ms, event name passed to the shim, skips reported', () => {
    const bt = settings.hooks!.BeforeTool[0]
    expect(bt.matcher).toBe('run_shell_command|web_fetch')
    expect(bt.hooks[0].timeout).toBe(10_000)
    expect(bt.hooks[0].command.startsWith('/usr/bin/node /x/shim/gemini-hook.mjs PreToolUse b64:')).toBe(true)
    expect(bt.hooks[0].name).toMatch(/^marveen-pretooluse-\d+$/)
    expect(settings.hooks!.BeforeAgent[0].matcher).toBeUndefined()
    expect(settings.hooks!.PreCompress).toBeUndefined()
    expect(skipped.some((s) => s.startsWith('PreCompact: agent-type'))).toBe(true)
    expect(skipped.some((s) => s.startsWith('SubagentStop: no Gemini equivalent'))).toBe(true)
    expect(settings.general).toEqual({ previewFeatures: false })
  })
  it('translateMatcher with the Gemini table', () => {
    expect(translateMatcher('Write|Edit|Read', CLAUDE_TO_GEMINI_TOOL)).toBe('write_file|replace|read_file')
  })
})

describe('prepareGeminiBundle (temp agent dir)', () => {
  const dir = join(tmp, 'agents', 'pixel')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), '# Pixel\nDesigner vagy.')
  writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}')
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Skill|Read', hooks: [{ type: 'command', command: 'python3 /x/cap.py', timeout: 10 }] }] } }))
  const spec: AgentSpec = { id: 'pixel', dir, role: 'sub', model: 'gemini-2.5-flash', runtime: 'gemini-cli', provider: 'google', authMode: 'api', securityProfile: 'marketer', displayName: 'Pixel' }
  it('writes GEMINI.md and .gemini/settings.json', () => {
    const b = prepareGeminiBundle(spec)
    expect(readFileSync(b.geminiMdPath, 'utf-8')).toContain('Designer vagy.')
    const s = JSON.parse(readFileSync(b.settingsPath, 'utf-8'))
    expect(s.hooks.AfterTool[0].matcher).toBe('Skill|read_file')
    expect(s.mcpServers).toBeUndefined()
    expect(b.skippedHooks).toEqual([])
  })
})

describe('gemini-hook.mjs shim (end to end with a fake gate)', () => {
  const shim = join(REPO, 'scripts', 'hooks', 'shim', 'gemini-hook.mjs')
  const gate = join(tmp, 'gate.sh')
  // Claude-dialect gate: records the payload; denies WebFetch to evil.com via hookSpecificOutput; plain text for UserPromptSubmit.
  writeFileSync(gate, `#!/bin/sh
IN=$(cat)
echo "$IN" > "$(dirname "$0")/seen.json"
case "$IN" in
  *evil.com*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"egress blocked"}}'; exit 0;;
  *UserPromptSubmit*) echo "[provenance] confirm on a verified channel"; exit 0;;
esac
exit 0
`)
  chmodSync(gate, 0o755)
  const b64 = Buffer.from(`sh ${gate}`).toString('base64')
  it('translates event + tool names into the Claude dialect and a deny into Gemini decision=deny', () => {
    const r = spawnSync(process.execPath, [shim, 'PreToolUse', `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'web_fetch', tool_input: { url: 'https://evil.com/x' }, cwd: tmp }), encoding: 'utf-8' })
    expect(r.status).toBe(0)
    const seen = JSON.parse(readFileSync(join(tmp, 'seen.json'), 'utf-8'))
    expect(seen.hook_event_name).toBe('PreToolUse')
    expect(seen.tool_name).toBe('WebFetch')
    const reply = JSON.parse(r.stdout.trim())
    expect(reply.decision).toBe('deny')
    expect(reply.reason).toBe('egress blocked')
  })
  it('plain stdout text becomes hookSpecificOutput.additionalContext', () => {
    const r = spawnSync(process.execPath, [shim, 'UserPromptSubmit', `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'BeforeAgent', prompt: 'restart now' }), encoding: 'utf-8' })
    expect(r.status).toBe(0)
    const reply = JSON.parse(r.stdout.trim())
    expect(reply.hookSpecificOutput.additionalContext).toBe('[provenance] confirm on a verified channel')
    expect(reply.decision).toBeUndefined()
  })
  it('fails closed without arguments', () => {
    expect(spawnSync(process.execPath, [shim], { input: '{}', encoding: 'utf-8' }).status).toBe(2)
  })
})

describe('adapter shape', () => {
  it('capabilities + unknown handle', async () => {
    const caps = geminiCliRuntime.capabilities({ id: 'x', dir: '/tmp/x', role: 'sub', model: 'gemini-2.5-pro', runtime: 'gemini-cli', provider: 'google', authMode: 'subscription', securityProfile: 'default' })
    expect(caps).toMatchObject({ interactive: false, supportsHooks: 'native', supportsMcp: true, reportsUsage: 'events', contextWindow: 1_048_576 })
    expect(await geminiCliRuntime.state({ agentId: 'x', runtime: 'gemini-cli', sessionRef: 'gemini:x:nope' })).toBe('dead')
  })
})
