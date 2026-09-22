import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildCodexArgs, buildCodexEnv, sandboxForProfile, prepareCodexBundle, codexHomeFor, codexCliRuntime,
} from '../runtime/codex-cli.js'
import type { AgentSpec } from '../runtime/types.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmp = mkdtempSync(join(tmpdir(), 'marveen-codex-'))
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('buildCodexArgs', () => {
  it('non-interactive JSON run, prompt on stdin, approvals off, sandbox as given', () => {
    const a = buildCodexArgs({ model: 'gpt-5.6-sol', cwd: '/w', sandbox: 'workspace-write', bypassHookTrust: true })
    expect(a).toEqual(['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.6-sol', '-C', '/w', '-c', 'approval_policy="never"', '-s', 'workspace-write', '--dangerously-bypass-hook-trust', '-'])
  })
  it('resume appends the subcommand after the exec options; stdin marker stays last', () => {
    const a = buildCodexArgs({ model: 'm', cwd: '/w', sandbox: 'read-only', resume: 'thr-1', configOverrides: ['model_context_window=200000'] })
    expect(a.slice(-3)).toEqual(['resume', 'thr-1', '-'])
    expect(a).toContain('model_context_window=200000')
    expect(a).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })
  it('the model id is its own argv element (no shell)', () => {
    const hostile = "x'; rm -rf /; echo '"
    const a = buildCodexArgs({ model: hostile, cwd: '/w', sandbox: 'read-only' })
    expect(a[a.indexOf('-m') + 1]).toBe(hostile)
  })
})

describe('buildCodexEnv', () => {
  const base = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'claude', TELEGRAM_BOT_TOKEN: 'leak', CODEX_API_KEY: 'stale' }
  it('subscription: isolated CODEX_HOME, no Claude/channel/API secrets leak in', () => {
    const env = buildCodexEnv({ spec: { id: 'a', model: 'gpt-5.6-sol', provider: 'openai', authMode: 'subscription' }, codexHome: '/h/.codex', secretLookup: () => 'k', base })
    expect(env.CODEX_HOME).toBe('/h/.codex')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
  })
  it('api: CODEX_API_KEY from the vault (per-agent override first)', () => {
    const env = buildCodexEnv({ spec: { id: 'scout', model: 'gpt-5.6-sol', provider: 'openai', authMode: 'api' }, codexHome: '/h', secretLookup: (id) => (id === 'agent-scout-api-key' ? 'own' : id === 'OPENAI_API_KEY' ? 'fleet' : null), base })
    expect(env.CODEX_API_KEY).toBe('own')
  })
})

describe('sandboxForProfile', () => {
  it('strict permission mode -> read-only; otherwise workspace-write', () => {
    expect(sandboxForProfile('researcher', 'strict')).toBe('read-only')
    expect(sandboxForProfile('researcher', 'permissive')).toBe('workspace-write')
    expect(sandboxForProfile('developer-junior', undefined)).toBe('workspace-write')
  })
})

describe('prepareCodexBundle (real files in a temp agent dir)', () => {
  const dir = join(tmp, 'agents', 'scout')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), '# Scout\nKutató vagy.')
  writeFileSync(join(dir, 'SOUL.md'), 'Kíváncsi.')
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { gmail: { command: 'npx', args: ['-y', 'gmail-mcp-server@latest'] } } }))
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'node /x/egress-gate.mjs', timeout: 10 }] }] } }))
  const spec: AgentSpec = { id: 'scout', dir, role: 'sub', model: 'gpt-5.6-sol', runtime: 'codex-cli', provider: 'openai', authMode: 'api', securityProfile: 'researcher', displayName: 'Scout' }

  it('renders AGENTS.md, config.toml and .codex/hooks.json', () => {
    const b = prepareCodexBundle(spec)
    expect(b.codexHome).toBe(codexHomeFor(dir))
    expect(readFileSync(b.agentsMdPath, 'utf-8')).toContain('Kutató vagy.')
    const toml = readFileSync(b.configPath, 'utf-8')
    expect(toml).toContain('model = "gpt-5.6-sol"')
    expect(toml).toContain('[mcp_servers.gmail]')
    expect(toml).toContain(`[projects."${dir}"]`)
    expect(b.hooksPath).toBe(join(dir, '.codex', 'hooks.json'))
    const hooks = JSON.parse(readFileSync(b.hooksPath!, 'utf-8'))
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('WebFetch')
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain('codex-hook.mjs b64:')
    expect(b.skippedHooks).toEqual([])
  })
  it('an operator-authored AGENTS.md is never overwritten; config.toml is regenerated', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'MINE')
    const b = prepareCodexBundle({ ...spec, model: 'gpt-5.7' })
    expect(readFileSync(b.agentsMdPath, 'utf-8')).toBe('MINE')
    expect(readFileSync(b.configPath, 'utf-8')).toContain('model = "gpt-5.7"')
  })
  it('api mode never links a host auth.json', () => {
    expect(existsSync(join(codexHomeFor(dir), 'auth.json'))).toBe(false)
  })
})

describe('codex-hook.mjs shim (end to end with a fake gate)', () => {
  const shim = join(REPO, 'scripts', 'hooks', 'shim', 'codex-hook.mjs')
  const gate = join(tmp, 'gate.sh')
  // Echoes the payload it received; blocks (exit 2) when tool_name is Bash and command mentions rm.
  writeFileSync(gate, '#!/bin/sh\nIN=$(cat)\necho "$IN" > "$(dirname "$0")/seen.json"\ncase "$IN" in *\\"Bash\\"*rm*) echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"rm blocked"}}\'; exit 2;; esac\nexit 0\n')
  chmodSync(gate, 0o755)
  const b64 = Buffer.from(`sh ${gate}`).toString('base64')

  it('maps Codex tool names to Claude names and forwards exit 0 + payload', () => {
    const r = spawnSync(process.execPath, [shim, `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { patch: 'x' }, cwd: tmp }), encoding: 'utf-8' })
    expect(r.status).toBe(0)
    const seen = JSON.parse(readFileSync(join(tmp, 'seen.json'), 'utf-8'))
    expect(seen.tool_name).toBe('Edit')
    expect(seen._marveen_runtime).toBe('codex-cli')
    expect(seen.tool_input).toEqual({ patch: 'x' })
  })
  it('propagates a block: exit 2 and the deny JSON on stdout', () => {
    const r = spawnSync(process.execPath, [shim, `b64:${b64}`], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'rm -rf /' } }), encoding: 'utf-8' })
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('"permissionDecision":"deny"')
    expect(JSON.parse(readFileSync(join(tmp, 'seen.json'), 'utf-8')).tool_name).toBe('Bash')
  })
  it('fails closed (exit 2) without a command argument', () => {
    const r = spawnSync(process.execPath, [shim], { input: '{}', encoding: 'utf-8' })
    expect(r.status).toBe(2)
  })
})

describe('adapter shape', () => {
  it('capabilities + unknown handle', async () => {
    const caps = codexCliRuntime.capabilities({ id: 'x', dir: '/tmp/x', role: 'sub', model: 'gpt-5.6-sol', runtime: 'codex-cli', provider: 'openai', authMode: 'subscription', securityProfile: 'default' })
    expect(caps).toMatchObject({ interactive: false, supportsResume: true, supportsHooks: 'native', supportsMcp: true, reportsUsage: 'events' })
    expect(await codexCliRuntime.state({ agentId: 'x', runtime: 'codex-cli', sessionRef: 'codex:x:nope' })).toBe('dead')
  })
})
