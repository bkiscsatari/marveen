import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { modelFor, MissingApiKeyError, vendorModelId, providerNeedsKey } from '../runtime/native-api/provider.js'
import { builtinTools, gated, type ToolContext } from '../runtime/native-api/tools.js'
import { trimHistory } from '../runtime/native-api/history.js'
import { listSkills, systemPromptFor, nativeApiRuntime } from '../runtime/native-api/index.js'
import { mcpToolId } from '../runtime/native-api/mcp-client.js'
import { buildPermissionSet } from '../runtime/permissions.js'
import type { PolicyEngine } from '../runtime/policy/engine.js'
import type { AgentSpec } from '../runtime/types.js'

const tmp = mkdtempSync(join(tmpdir(), 'marveen-native-'))
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('provider factory', () => {
  const lookup = (id: string) => (/API_KEY|api-key|fleet-key/.test(id) ? 'k' : null)
  it('builds a model object for every vendor (no network)', () => {
    for (const [provider, model] of [['anthropic', 'claude-sonnet-5'], ['openai', 'gpt-5.6-sol'], ['google', 'gemini-2.5-flash'], ['deepseek', 'deepseek-chat'], ['minimax', 'MiniMax-M3'], ['moonshot', 'kimi-k3'], ['zhipu', 'glm-5.3'], ['openrouter', 'qwen/qwen3'], ['ollama', 'qwen2.5:1.5b']] as const) {
      const m = modelFor({ agentId: 'a', provider, model, secretLookup: lookup })
      expect(m, provider).toBeTruthy()
      expect(typeof m === 'string' ? m : (m as { modelId: string }).modelId).toBe(model)
    }
  })
  it('throws MissingApiKeyError naming the vault ids (never values) when a key is absent; ollama needs none', () => {
    expect(() => modelFor({ agentId: 'argus', provider: 'deepseek', model: 'deepseek-chat', secretLookup: () => null })).toThrow(MissingApiKeyError)
    try { modelFor({ agentId: 'argus', provider: 'deepseek', model: 'deepseek-chat', secretLookup: () => null }) } catch (e) {
      expect((e as Error).message).toContain('agent-argus-api-key')
      expect((e as Error).message).toContain('DEEPSEEK_API_KEY')
    }
    expect(() => modelFor({ agentId: 'a', provider: 'ollama', model: 'x', secretLookup: () => null })).not.toThrow()
    expect(providerNeedsKey('ollama')).toBe(false)
  })
  it('strips the [1m] suffix for the vendor', () => {
    expect(vendorModelId('claude-opus-5[1m]')).toBe('claude-opus-5')
    const m = modelFor({ agentId: 'a', provider: 'anthropic', model: 'claude-opus-5[1m]', secretLookup: lookup })
    expect((m as { modelId: string }).modelId).toBe('claude-opus-5')
  })
})

function stubPolicy(decide: (tool: string, input: unknown) => { allowed: boolean; reason?: string; updatedInput?: unknown }): PolicyEngine {
  const calls: Array<[string, string]> = []
  return {
    calls,
    preToolUse: async (t: string, i: unknown) => { calls.push(['pre', t]); const d = decide(t, i); return { ...d, additionalContext: [], outcomes: [] } },
    postToolUse: async (t: string) => { calls.push(['post', t]); return { allowed: true, additionalContext: [], outcomes: [] } },
  } as unknown as PolicyEngine
}

describe('built-in tools with permission + hook gates', () => {
  const dir = join(tmp, 'agent'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'note.txt'), 'hello marveen')
  const permissions = buildPermissionSet({ allow: ['Read(${AGENT_DIR}/**)', 'Write(${AGENT_DIR}/**)', 'Edit(${AGENT_DIR}/**)', 'Bash(echo:*)'], deny: ['Read(**/.env)', 'Bash(rm:*)'] }, 'strict', { AGENT_DIR: dir, HOME: tmp })
  const policy = stubPolicy((t, i) => (t === 'Bash' && String((i as { command?: string }).command).includes('secret') ? { allowed: false, reason: 'hook says no' } : { allowed: true }))
  const calls: Array<{ name: string; ok: boolean }> = []
  const ctx: ToolContext = { cwd: dir, permissions, policy, onCall: (r) => calls.push({ name: r.name, ok: r.ok }) }
  const tools = builtinTools(ctx)
  const exec = (name: string, input: unknown) => (tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] })

  it('Read inside the agent dir works; Read of .env is denied by permissions before any hook runs', async () => {
    expect(await exec('Read', { file_path: 'note.txt' })).toBe('hello marveen')
    const r = await exec('Read', { file_path: join(dir, '.env') })
    expect(String(r)).toMatch(/blocked by permissions/)
    expect((policy as unknown as { calls: Array<[string, string]> }).calls.filter((c) => c[0] === 'pre' && c[1] === 'Read')).toHaveLength(1)
  })
  it('Write + Edit round trip', async () => {
    await exec('Write', { file_path: 'out.txt', content: 'a b c' })
    await exec('Edit', { file_path: 'out.txt', old_string: 'b', new_string: 'X' })
    expect(readFileSync(join(dir, 'out.txt'), 'utf-8')).toBe('a X c')
  })
  it('Bash: allow-listed echo runs with exit code; rm denied by permissions; hook denial surfaces as ERROR text', async () => {
    expect(String(await exec('Bash', { command: 'echo hi' }))).toMatch(/hi[\s\S]*\[exit 0\]/)
    expect(String(await exec('Bash', { command: 'rm -rf /' }))).toMatch(/blocked by permissions/)
    expect(String(await exec('Bash', { command: 'echo secret' }))).toMatch(/blocked by governance hook -- hook says no/)
    expect(calls.filter((c) => c.name === 'Bash' && c.ok)).toHaveLength(1)
  })
  it('ListDir lists entries', async () => {
    expect(String(await exec('ListDir', {}))).toContain('note.txt')
  })
  it('gated() reports thrown errors as ERROR text instead of failing the run', async () => {
    const r = await gated(ctx, 'Read', join(dir, 'x'), {}, async () => { throw new Error('boom') })
    expect(r).toBe('ERROR: Read failed -- boom')
  })
})

describe('history + prompt helpers', () => {
  it('trimHistory keeps the newest N and never starts on a tool result', () => {
    const msgs = [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'tool', content: [] as never },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
    ] as never[]
    expect(trimHistory(msgs, 3).map((m) => (m as { role: string }).role)).toEqual(['user', 'assistant'])
    expect(trimHistory(msgs, 10)).toHaveLength(5)
  })
  it('listSkills + systemPromptFor render CLAUDE.md/SOUL.md/skills into the system prompt', () => {
    const dir = join(tmp, 'skilled'); mkdirSync(join(dir, '.claude', 'skills', 'deep-research'), { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '# Scout\nKutató vagy.')
    writeFileSync(join(dir, 'SOUL.md'), 'Kíváncsi.')
    writeFileSync(join(dir, '.claude', 'skills', 'deep-research', 'SKILL.md'), '---\nname: deep-research\ndescription: Mély kutatás\n---\n# x')
    expect(listSkills(dir)).toEqual([{ name: 'deep-research', path: '.claude/skills/deep-research/SKILL.md', description: 'Mély kutatás' }])
    const spec: AgentSpec = { id: 'scout', dir, role: 'sub', model: 'qwen2.5:1.5b', runtime: 'native-api', provider: 'ollama', authMode: 'api', securityProfile: 'researcher', displayName: 'Scout' }
    const sp = systemPromptFor(spec)
    expect(sp).toContain('Kutató vagy.')
    expect(sp).toContain('Kíváncsi.')
    expect(sp).toContain('deep-research')
    expect(sp).toContain('native-api runtime')
    expect(sp.startsWith('<!--')).toBe(false)
  })
  it('mcpToolId follows the Claude Code spelling', () => {
    expect(mcpToolId('marveen-channel', 'reply')).toBe('mcp__marveen_channel__reply')
    expect(mcpToolId('plugin:telegram', 'reply')).toBe('mcp__plugin_telegram__reply')
  })
})

describe('adapter shape', () => {
  it('capabilities: policy-engine hooks, events usage; unknown handle is dead', async () => {
    const caps = nativeApiRuntime.capabilities({ id: 'x', dir: '/tmp/x', role: 'sub', model: 'deepseek-v4-pro', runtime: 'native-api', provider: 'deepseek', authMode: 'api', securityProfile: 'default' })
    expect(caps).toMatchObject({ interactive: false, supportsResume: true, supportsHooks: 'policy-engine', supportsMcp: true, reportsUsage: 'events', contextWindow: 200_000 })
    expect(await nativeApiRuntime.state({ agentId: 'x', runtime: 'native-api', sessionRef: 'native:x:nope' })).toBe('dead')
  })
})
