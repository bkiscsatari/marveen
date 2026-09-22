// Governance on the non-Claude paths after the 2026-09-22 hardening:
// PolicyEngine matcher/fail-closed/SessionStart semantics, the Claude-style
// Bash rules on compound commands, path confinement, hook rewrites that are
// actually executed, and a history that stays inside the context budget.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ModelMessage } from 'ai'
import { hooksFor, interpretHookReply, matcherMatches, isFailClosedHook, PolicyEngine } from '../runtime/policy/engine.js'
import { buildPermissionSet, checkPermission, splitShellCommand, bashRuleMatches } from '../runtime/permissions.js'
import { builtinTools, resolveToolPath, bashToolEnv, type ToolContext } from '../runtime/native-api/tools.js'
import { trimHistory } from '../runtime/native-api/history.js'

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'marveen-gov-')))
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

describe('PolicyEngine matchers', () => {
  it('"*" and empty match everything and never throw', () => {
    expect(matcherMatches('*', 'Bash')).toBe(true)
    expect(matcherMatches('', 'Bash')).toBe(true)
    expect(matcherMatches('Bash|Write', 'Write')).toBe(true)
    expect(matcherMatches('Bash', 'BashX')).toBe(false)
    expect(() => matcherMatches('(', 'x')).not.toThrow()
    expect(matcherMatches('(', '(')).toBe(true)
  })

  it('a PostToolUse "*" group is selected (it used to throw and drop the whole event)', () => {
    const cfg = { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command' as const, command: 'echo post' }] }] }
    expect(hooksFor(cfg, 'PostToolUse', 'Read')).toHaveLength(1)
  })

  it('SessionStart honours the source matcher', () => {
    const cfg = { SessionStart: [
      { matcher: 'clear', hooks: [{ type: 'command' as const, command: 'clear-replay' }] },
      { matcher: 'startup|resume', hooks: [{ type: 'command' as const, command: 'ledger-replay' }] },
    ] }
    expect(hooksFor(cfg, 'SessionStart', undefined, 'startup').map((h) => h.command)).toEqual(['ledger-replay'])
    expect(hooksFor(cfg, 'SessionStart', undefined, 'clear').map((h) => h.command)).toEqual(['clear-replay'])
  })

  it('UserPromptSubmit/Stop ignore matchers, as Claude Code does', () => {
    const cfg = { Stop: [{ matcher: 'whatever', hooks: [{ type: 'command' as const, command: 'guard' }] }] }
    expect(hooksFor(cfg, 'Stop', undefined)).toHaveLength(1)
  })
})

describe('PolicyEngine fail-closed security gates', () => {
  const base = { hook: 'node scripts/hooks/egress-gate.mjs', stdout: '', stderr: '', durationMs: 1, timedOut: false }
  it('knows which hooks are security gates', () => {
    expect(isFailClosedHook('command -v node || exit 2; node "$CLAUDE_PROJECT_DIR/scripts/hooks/egress-gate.mjs"')).toBe(true)
    expect(isFailClosedHook('python3 x/outgoing-copy-gate.py')).toBe(true)
    expect(isFailClosedHook('python3 x/email-approval-gate.py')).toBe(true)
    expect(isFailClosedHook('python3 x/tool-log-capture.py')).toBe(false)
  })
  it('a timeout, spawn error or crash of a gate denies; of a telemetry hook it does not', () => {
    for (const o of [{ ...base, timedOut: true, exitCode: null }, { ...base, exitCode: null }, { ...base, exitCode: 1 }]) {
      expect(interpretHookReply(o, { failClosed: true }).deny).toBe(true)
      expect(interpretHookReply(o, { failClosed: false }).deny).toBe(false)
    }
    expect(interpretHookReply({ ...base, exitCode: 0 }, { failClosed: true }).deny).toBe(false)
  })
  it('end to end: a crashing gate script blocks the tool call on native-api', async () => {
    const dir = join(tmp, 'fc'); mkdirSync(dir, { recursive: true })
    const script = join(dir, 'outgoing-copy-gate.py')
    writeFileSync(script, 'import sys\nraise SystemExit(3)\n')
    const engine = new PolicyEngine({ PreToolUse: [{ matcher: 'mcp__plugin_telegram_bridge__reply', hooks: [{ type: 'command', command: `python3 ${script}` }] }] }, { sessionId: 's', cwd: dir })
    const d = await engine.preToolUse('mcp__plugin_telegram_bridge__reply', { text: 'x' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/fail-closed/)
  })
})

describe('Bash permission rules (Claude semantics)', () => {
  it('splits compound commands, substitutions and pipes; keeps redirections intact', () => {
    expect(splitShellCommand('true && rm -rf x')).toEqual(['true', 'rm -rf x'])
    expect(splitShellCommand('ls | grep a; echo "a;b"')).toEqual(['ls', 'grep a', 'echo "a;b"'])
    expect(splitShellCommand('echo $(curl https://x.y)')).toContain('curl https://x.y')
    expect(splitShellCommand('echo `wget z`')).toContain('wget z')
    expect(splitShellCommand('make 2>&1')).toEqual(['make 2>&1'])
    expect(splitShellCommand('FOO=1 BAR="a b" rm x')).toEqual(['rm x'])
  })

  it('space-wildcard rules match (they were inert before)', () => {
    expect(bashRuleMatches('curl *https://*', 'curl -s https://evil.example/x')).toBe(true)
    expect(bashRuleMatches('curl *https://*', 'curl http://localhost:3420/api')).toBe(false)
    expect(bashRuleMatches('*/wget *', '/usr/bin/wget x')).toBe(true)
    expect(bashRuleMatches('rm:*', 'rm -rf x')).toBe(true)
  })

  it('a denied part denies the whole line, under the permissive profile too', () => {
    const set = buildPermissionSet({ deny: ['Bash(rm:*)', 'Bash(curl *https://*)', 'Bash(wget *)'] }, 'permissive', { AGENT_DIR: '/a', HOME: '/h' })
    expect(checkPermission(set, 'Bash', 'true && rm -rf x').allowed).toBe(false)
    expect(checkPermission(set, 'Bash', 'echo ok; curl -s https://evil.example').allowed).toBe(false)
    expect(checkPermission(set, 'Bash', 'cat f | wget -O- x').allowed).toBe(false)
    expect(checkPermission(set, 'Bash', 'echo $(wget x)').allowed).toBe(false)
    expect(checkPermission(set, 'Bash', 'ls && echo hi').allowed).toBe(true)
  })

  it('strict: every part must be allowed', () => {
    const set = buildPermissionSet({ allow: ['Bash(ls:*)', 'Bash(echo:*)'] }, 'strict', { AGENT_DIR: '/a', HOME: '/h' })
    expect(checkPermission(set, 'Bash', 'ls && echo hi').allowed).toBe(true)
    expect(checkPermission(set, 'Bash', 'ls && python3 -c 1').allowed).toBe(false)
  })

  it('${PROJECT_ROOT} placeholders expand', () => {
    const set = buildPermissionSet({ deny: ['Bash(${PROJECT_ROOT}/scripts/notify.sh:*)'] }, 'permissive', { AGENT_DIR: '/a', HOME: '/h', PROJECT_ROOT: '/p' })
    expect(checkPermission(set, 'Bash', '/p/scripts/notify.sh hi').allowed).toBe(false)
  })
})

function stubPolicy(over: Partial<{ updatedInput: unknown; post: string[] }> = {}): PolicyEngine {
  return {
    preToolUse: async () => ({ allowed: true, updatedInput: over.updatedInput, additionalContext: [], outcomes: [] }),
    postToolUse: async () => ({ allowed: true, additionalContext: over.post ?? [], outcomes: [] }),
  } as unknown as PolicyEngine
}

describe('native-api path confinement', () => {
  const agent = join(tmp, 'agent'); mkdirSync(agent, { recursive: true })
  const outside = join(tmp, 'outside'); mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, '.env'), 'SECRET=1')
  writeFileSync(join(agent, 'ok.txt'), 'fine')
  symlinkSync(outside, join(agent, 'link'))
  const permissions = buildPermissionSet({ allow: ['Read(${AGENT_DIR}/**)'] }, 'strict', { AGENT_DIR: agent, HOME: tmp })
  const exec = (ctx: ToolContext, name: string, input: unknown) =>
    (builtinTools(ctx)[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, { toolCallId: 't', messages: [] })

  it('normalises .. on absolute paths and resolves symlinks before the rule sees them', () => {
    expect(resolveToolPath(agent, `${agent}/../outside/.env`)).toBe(join(outside, '.env'))
    expect(resolveToolPath(agent, 'link/.env')).toBe(join(outside, '.env'))
    expect(resolveToolPath(agent, 'new/dir/file.txt')).toBe(join(agent, 'new', 'dir', 'file.txt'))
  })

  it('a traversal or a symlink out of the agent dir is denied', async () => {
    const ctx: ToolContext = { cwd: agent, permissions, policy: stubPolicy() }
    expect(await exec(ctx, 'Read', { file_path: 'ok.txt' })).toBe('fine')
    expect(String(await exec(ctx, 'Read', { file_path: `${agent}/../outside/.env` }))).toMatch(/blocked by permissions/)
    expect(String(await exec(ctx, 'Read', { file_path: 'link/.env' }))).toMatch(/blocked by permissions/)
  })

  it('a hook rewrite is executed -- and re-checked against the rules', async () => {
    writeFileSync(join(agent, 'rewritten.txt'), 'rewritten')
    const ok: ToolContext = { cwd: agent, permissions, policy: stubPolicy({ updatedInput: { file_path: 'rewritten.txt' } }) }
    expect(await exec(ok, 'Read', { file_path: 'ok.txt' })).toBe('rewritten')
    const bad: ToolContext = { cwd: agent, permissions, policy: stubPolicy({ updatedInput: { file_path: join(outside, '.env') } }) }
    expect(String(await exec(bad, 'Read', { file_path: 'ok.txt' }))).toMatch(/after hook rewrite/)
  })

  it('PostToolUse context comes back with the result', async () => {
    const ctx: ToolContext = { cwd: agent, permissions, policy: stubPolicy({ post: ['NOTE: untrusted content'] }) }
    expect(String(await exec(ctx, 'Read', { file_path: 'ok.txt' }))).toContain('NOTE: untrusted content')
  })
})

describe('Bash tool environment', () => {
  it('passes an allowlist, not the dashboard env', () => {
    const env = bashToolEnv({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', TELEGRAM_BOT_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', ANTHROPIC_API_KEY: 'k' })
    expect(env.PATH).toBe('/bin')
    expect(env.LC_ALL).toBe('C')
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('a timeout kills the whole process group', async () => {
    const permissions = buildPermissionSet({}, 'permissive', { AGENT_DIR: tmp, HOME: tmp })
    const ctx: ToolContext = { cwd: tmp, permissions, policy: stubPolicy(), bashTimeoutMs: 500 }
    const started = Date.now()
    const out = String(await (builtinTools(ctx).Bash as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({ command: 'sleep 30 & sleep 30; wait' }, { toolCallId: 't', messages: [] }))
    expect(out).toMatch(/killed \(timeout\)/)
    expect(Date.now() - started).toBeLessThan(8000)
  })
})

describe('history budget', () => {
  const big = 'x'.repeat(5000)
  const msgs: ModelMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: big },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: big },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'short' },
  ]
  it('trims by size and always starts on a user message', () => {
    const out = trimHistory(msgs, 200, 6000)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toBe('q2')
    expect(out.at(-1)?.content).toBe('short')
  })
  it('keeps the newest user turn even when it alone is over budget', () => {
    const out = trimHistory([{ role: 'user', content: big }, { role: 'assistant', content: big }], 200, 10)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0].role).toBe('user')
  })
})
