import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { MinimaxStreamAccumulator, minimaxSummaryToRunResult, minimaxShowsAuthFailure, minimaxToolName, parseMinimaxLine } from '../runtime/minimax-events.js'
import { buildMinimaxArgs, buildMinimaxEnv, mcodeModelId, permissionForProfile, renderMinimaxConfigYaml, renderClaudePluginForHooks, prepareMinimaxBundle, minimaxCliRuntime } from '../runtime/minimax-cli.js'
import { resolveRuntimeSpec, defaultRuntimeFor, runtimeSupportsProvider } from '../runtime/resolve-spec.js'
import type { AgentSpec } from '../runtime/types.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'minimax-cli')
const CTX = { runtime: 'minimax-cli' as const, provider: 'minimax' as const, model: 'minimax-m2.7-highspeed' }
const tmp = mkdtempSync(join(tmpdir(), 'marveen-minimax-'))
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

function feed(name: string, onText?: (t: string) => void) {
  const acc = new MinimaxStreamAccumulator({ onText })
  for (const line of readFileSync(join(FIX, name), 'utf-8').split('\n')) acc.push(line)
  return acc.summary()
}

describe('minimax-events: text-ok.jsonl (source-derived)', () => {
  const s = feed('text-ok.jsonl')
  it('session id, model, deltas folded into the completed message, tool call mapped to Read', () => {
    expect(s.sessionId).toBe('sess_abc')
    expect(s.model).toBe('MiniMax-M2.7-highspeed')
    expect(s.messages).toEqual(['marveen-probe-42'])
    expect(s.toolCalls).toEqual([{ name: 'Read', input: { path: 'secret-number.txt' }, ok: true }])
    expect(s.turnCompleted).toBe(true)
    expect(s.result?.status).toBe('succeeded')
  })
  it('RunResult with usage (input/output/cacheRead) and sessionRef', () => {
    const r = minimaxSummaryToRunResult(s, { ...CTX, timestamp: 9, exitCode: 0 })
    expect(r.blocked).toBe(false)
    expect(r.text).toBe('marveen-probe-42')
    expect(r.usage).toMatchObject({ inputTokens: 1200, outputTokens: 40, cacheReadTokens: 900, model: 'MiniMax-M2.7-highspeed', runtime: 'minimax-cli', provider: 'minimax', timestamp: 9 })
    expect(r.usage?.costUsd).toBeUndefined()
    expect(r.sessionRef).toBe('sess_abc')
  })
  it('streams deltas to onText exactly once each', () => {
    const chunks: string[] = []
    feed('text-ok.jsonl', (t) => chunks.push(t))
    expect(chunks).toEqual(['marveen-', 'probe-42'])
  })
})

describe('minimax-events: recorded live (subscription, mcode 0.5.1)', () => {
  it('tool-read: reasoning + numeric-status tool call with `input`, message, live usage keys, exec.result session id', () => {
    const s = feed('recorded-tool-read.jsonl')
    expect(s.sessionId).toMatch(/^mvs_/)
    expect(s.messages).toEqual(['marveen-probe-42'])
    expect(s.reasoning.length).toBeGreaterThanOrEqual(1)
    expect(s.toolCalls).toHaveLength(1)
    expect(s.toolCalls[0].name).toBe('Read')
    expect(s.toolCalls[0].ok).toBe(true)
    expect(JSON.stringify(s.toolCalls[0].input)).toContain('secret-number.txt')
    const r = minimaxSummaryToRunResult(s, { ...CTX, exitCode: 0 })
    expect(r.blocked).toBe(false)
    expect(r.text).toBe('marveen-probe-42')
    expect(r.usage).toMatchObject({ outputTokens: 114, cacheReadTokens: 23612, cacheCreationTokens: 426 })
    expect(r.sessionRef).toBe(s.sessionId)
  })
  it('resume: same session id as the tool run, answers "42"', () => {
    const a = feed('recorded-tool-read.jsonl'); const b = feed('recorded-resume.jsonl')
    expect(b.sessionId).toBe(a.sessionId)
    expect(minimaxSummaryToRunResult(b, CTX).text).toBe('42')
  })
  it('probe-ok: plain OK reply', () => {
    expect(minimaxSummaryToRunResult(feed('recorded-probe-ok.jsonl'), CTX).text).toMatch(/\bOK\b/)
  })
})

describe('minimax-events: failure shapes', () => {
  it('auth-less run: empty stdout, exit 3, stderr hint -> blocked + auth', () => {
    const acc = new MinimaxStreamAccumulator()
    const stderr = 'mcode exec failed: Sign in to MiniMax to use Agent features. Run `mcode login`, then retry.'
    const r = minimaxSummaryToRunResult(acc.summary(), { ...CTX, exitCode: 3, stderrTail: stderr })
    expect(r.blocked).toBe(true)
    expect(r.reason).toContain('exit=3 (auth')
    expect(minimaxShowsAuthFailure(acc.summary(), stderr, 3)).toBe(true)
  })
  it('turn.failed carries the error; exec.result json document alone is understood', () => {
    const acc = new MinimaxStreamAccumulator()
    acc.push('{"type":"turn.failed","status":"failed","error":{"message":"model overloaded"},"durationMs":5}')
    expect(minimaxSummaryToRunResult(acc.summary(), CTX).reason).toMatch(/turn\.failed=model overloaded/)
    const acc2 = new MinimaxStreamAccumulator()
    acc2.push('{"schemaVersion":1,"type":"exec.result","runId":"r","sessionId":"s2","turnId":"t","status":"succeeded","output":"PONG","usage":{"input":3,"output":1},"durationMs":10}')
    const r = minimaxSummaryToRunResult(acc2.summary(), CTX)
    expect(r).toMatchObject({ text: 'PONG', blocked: false, sessionRef: 's2' })
  })
  it('parseMinimaxLine ignores junk; tool-name map', () => {
    expect(parseMinimaxLine('Waiting for authorization…')).toBeNull()
    expect(minimaxToolName('bash')).toBe('Bash'); expect(minimaxToolName('web_fetch')).toBe('WebFetch'); expect(minimaxToolName('reply')).toBe('reply')
  })
})

describe('minimax-cli builders', () => {
  it('mcodeModelId maps Marveen ids to mcode provider/model ids', () => {
    expect(mcodeModelId('minimax-m3')).toBe('minimax/MiniMax-M3')
    expect(mcodeModelId('minimax-m2.7-highspeed')).toBe('minimax/MiniMax-M2.7-highspeed')
    expect(mcodeModelId('MiniMax-M3')).toBe('minimax/MiniMax-M3')
    expect(mcodeModelId('minimax/MiniMax-M3.1')).toBe('minimax/MiniMax-M3.1')
  })
  it('buildMinimaxArgs: stdin prompt, stream-json, permission, model, cwd, resume/continue, config, timeout, steps', () => {
    const a = buildMinimaxArgs({ model: 'minimax-m3', cwd: '/w', permission: 'full', resume: 'sess_1', continueLatest: true, configPath: '/w/.minimax/runtime-config.yaml', timeoutMs: 90_000, maxSteps: 60, outputLastMessage: '/tmp/last.txt' })
    expect(a.slice(0, 4)).toEqual(['exec', '--input', '-', '--output-format'])
    expect(a).toContain('stream-json')
    expect(a[a.indexOf('--permission') + 1]).toBe('full')
    expect(a[a.indexOf('--model') + 1]).toBe('minimax/MiniMax-M3')
    expect(a[a.indexOf('--session') + 1]).toBe('sess_1')
    expect(a).not.toContain('--continue')
    expect(a[a.indexOf('--timeout') + 1]).toBe('90s')
    expect(a[a.indexOf('--max-steps') + 1]).toBe('60')
    expect(a[a.indexOf('-o') + 1]).toBe('/tmp/last.txt')
    expect(buildMinimaxArgs({ model: 'm', cwd: '/w', permission: 'off', continueLatest: true })).toContain('--continue')
  })
  it('buildMinimaxEnv: subscription keeps only the data dir; api injects MINIMAX_API_KEY; foreign secrets stripped', () => {
    const base = { PATH: '/usr/bin', MINIMAX_API_KEY: 'stale', CLAUDE_CODE_OAUTH_TOKEN: 'c', TELEGRAM_BOT_TOKEN: 'leak' }
    const sub = buildMinimaxEnv({ spec: { id: 'a', model: 'minimax-m3', provider: 'minimax', authMode: 'subscription' }, dataDir: '/h/.minimax', secretLookup: () => 'k', base })
    expect(sub.MINIMAX_DATA_DIR).toBe('/h/.minimax'); expect(sub.MINIMAX_API_KEY).toBeUndefined(); expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); expect(sub.TELEGRAM_BOT_TOKEN).toBeUndefined()
    const api = buildMinimaxEnv({ spec: { id: 'a', model: 'minimax-m3', provider: 'minimax', authMode: 'api' }, dataDir: '/h', secretLookup: (id) => (id === 'MINIMAX_API_KEY' ? 'mm' : null), base })
    expect(api.MINIMAX_API_KEY).toBe('mm')
  })
  it('permissionForProfile + config yaml', () => {
    expect(permissionForProfile(undefined, false)).toBe('off')
    expect(permissionForProfile('strict', true)).toBe('smart')
    expect(permissionForProfile('permissive', undefined)).toBe('full')
    expect(renderMinimaxConfigYaml({ model: 'minimax-m3', permission: 'full' })).toContain('defaultModel: minimax/MiniMax-M3')
  })
  it('renderClaudePluginForHooks keeps command hooks verbatim (Claude format), skips agent-type ones', () => {
    const r = renderClaudePluginForHooks('marveen-hooks-scout', {
      PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'node /x/egress-gate.mjs', timeout: 10 }] }],
      PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }],
    })
    expect(r.manifest).toMatchObject({ name: 'marveen-hooks-scout', version: '1.0.0' })
    expect(r.hooks).toEqual({ hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'node /x/egress-gate.mjs', timeout: 10 }] }] } })
    expect(r.skipped).toEqual(['PreCompact: agent-type hook has no plugin equivalent'])
    expect(renderClaudePluginForHooks('x', null).hooks).toBeNull()
  })
})

describe('prepareMinimaxBundle (temp agent dir + temp MINIMAX_DATA_DIR, no plugin install)', () => {
  const dir = join(tmp, 'agents', 'scout')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), '# Scout\nKutató vagy.')
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { gmail: { command: 'npx', args: ['-y', 'g'] } } }))
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'node /x/egress-gate.mjs', timeout: 10 }] }] } }))
  const spec: AgentSpec = { id: 'scout', dir, role: 'sub', model: 'minimax-m3', runtime: 'minimax-cli', provider: 'minimax', authMode: 'subscription', securityProfile: 'researcher', displayName: 'Scout', extraMcpServers: { plugin_telegram_bridge: { command: '/usr/bin/node', args: ['/x/mcp-server.js'] } } }
  it('renders AGENTS.md, runtime config, merged .mcp.json and the Claude-format hooks plugin in the local marketplace dir', () => {
    const prev = process.env.MINIMAX_DATA_DIR
    process.env.MINIMAX_DATA_DIR = join(tmp, 'data')
    try {
      const b = prepareMinimaxBundle(spec, { installPlugin: false })
      expect(readFileSync(b.agentsMdPath, 'utf-8')).toContain('Kutató vagy.')
      expect(readFileSync(b.configPath, 'utf-8')).toContain('minimax/MiniMax-M3')
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'))
      expect(Object.keys(mcp.mcpServers).sort()).toEqual(['gmail', 'plugin_telegram_bridge'])
      expect(b.pluginName).toBe('marveen-hooks-scout')
      expect(b.pluginDir).toBe(join(tmp, 'data', 'plugins', 'marveen-hooks-scout'))
      expect(existsSync(join(b.pluginDir!, '.claude-plugin', 'plugin.json'))).toBe(true)
      const hooks = JSON.parse(readFileSync(join(b.pluginDir!, 'hooks', 'hooks.json'), 'utf-8'))
      expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe('node /x/egress-gate.mjs')
      expect(b.skippedHooks).toEqual([])
    } finally { if (prev === undefined) delete process.env.MINIMAX_DATA_DIR; else process.env.MINIMAX_DATA_DIR = prev }
  })
})

describe('runtime axes: minimax subscription -> minimax-cli, api stays on the Claude-CLI path', () => {
  it('defaults', () => {
    expect(defaultRuntimeFor('minimax', 'subscription', 'sub')).toBe('minimax-cli')
    expect(defaultRuntimeFor('minimax', 'api', 'sub')).toBe('claude-tmux')
    expect(runtimeSupportsProvider('minimax-cli', 'minimax')).toBe(true)
    expect(runtimeSupportsProvider('minimax-cli', 'openai')).toBe(false)
    expect(resolveRuntimeSpec('minimax-m3', { authMode: 'subscription' }, { role: 'sub' })).toMatchObject({ runtime: 'minimax-cli', provider: 'minimax', authMode: 'subscription' })
    expect(resolveRuntimeSpec('minimax-m3', {}, { role: 'sub' })).toMatchObject({ runtime: 'claude-tmux', authMode: 'api' })
  })
  it('adapter shape', async () => {
    const caps = minimaxCliRuntime.capabilities({ id: 'x', dir: '/tmp/x', role: 'sub', model: 'minimax-m3', runtime: 'minimax-cli', provider: 'minimax', authMode: 'subscription', securityProfile: 'default' })
    expect(caps).toMatchObject({ interactive: false, supportsHooks: 'native', supportsMcp: true, reportsUsage: 'events', contextWindow: 1_000_000 })
    expect(await minimaxCliRuntime.state({ agentId: 'x', runtime: 'minimax-cli', sessionRef: 'minimax:x:nope' })).toBe('dead')
  })
})
