import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PolicyEngine, hooksFor, interpretHookReply } from '../runtime/policy/engine.js'

const tmp = mkdtempSync(join(tmpdir(), 'marveen-policy-'))
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

function script(name: string, body: string): string {
  const p = join(tmp, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p
}
const seen = join(tmp, 'seen.json')
const egress = script('egress.sh', `IN=$(cat); echo "$IN" > ${seen}; case "$IN" in *evil.com*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"egress blocked"}}'; exit 0;; esac; exit 0`)
const hardBlock = script('hard.sh', `echo "no rm here" >&2; exit 2`)
const context = script('ctx.sh', `echo "[provenance] confirm on a verified channel"; exit 0`)
const rewrite = script('rewrite.sh', `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"echo rewritten"}}}'; exit 0`)
const flaky = script('flaky.sh', `echo "meh" >&2; exit 1`)
const slow = script('slow.sh', `sleep 5; exit 0`)

const config = {
  PreToolUse: [
    { matcher: 'WebFetch', hooks: [{ type: 'command', command: `sh ${egress}`, timeout: 10 }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: `sh ${hardBlock}`, timeout: 10 }] },
    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: `sh ${rewrite}`, timeout: 10 }] },
  ],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: `sh ${context}`, timeout: 10 }, { type: 'command', command: `sh ${flaky}`, timeout: 10 }] }],
  Stop: [{ hooks: [{ type: 'command', command: `sh ${slow}`, timeout: 1 }] }],
  PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }],
}

describe('hooksFor', () => {
  it('matches regex matchers against the tool name; empty matcher = all; agent hooks ignored', () => {
    expect(hooksFor(config, 'PreToolUse', 'WebFetch').map((h) => h.command)).toEqual([`sh ${egress}`])
    expect(hooksFor(config, 'PreToolUse', 'Edit').map((h) => h.command)).toEqual([`sh ${rewrite}`])
    expect(hooksFor(config, 'PreToolUse', 'Read')).toEqual([])
    expect(hooksFor(config, 'UserPromptSubmit', undefined)).toHaveLength(2)
    expect(hooksFor(config, 'PreCompact', undefined)).toEqual([])
    expect(hooksFor(null, 'PreToolUse', 'Bash')).toEqual([])
  })
})

describe('interpretHookReply (pure)', () => {
  const base = { hook: 'x', stdout: '', stderr: '', durationMs: 1, timedOut: false }
  it('exit 2 blocks with stderr reason', () => {
    expect(interpretHookReply({ ...base, exitCode: 2, stderr: 'nope' })).toEqual({ deny: true, reason: 'nope' })
  })
  it('permissionDecision deny / decision block / continue:false all block', () => {
    expect(interpretHookReply({ ...base, exitCode: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"r"}}' }).deny).toBe(true)
    expect(interpretHookReply({ ...base, exitCode: 0, stdout: '{"decision":"block","reason":"r"}' }).deny).toBe(true)
    expect(interpretHookReply({ ...base, exitCode: 0, stdout: '{"continue":false,"stopReason":"s"}' })).toMatchObject({ deny: true, reason: 's' })
  })
  it('plain stdout is context; timeouts fail open', () => {
    expect(interpretHookReply({ ...base, exitCode: 0, stdout: 'hello' })).toEqual({ deny: false, context: 'hello' })
    expect(interpretHookReply({ ...base, exitCode: null, timedOut: true }).deny).toBe(false)
  })
})

describe('PolicyEngine (real hook processes)', () => {
  const engine = new PolicyEngine(config, { sessionId: 'sess-1', cwd: tmp })
  it('PreToolUse: allow, with the Claude-dialect payload on stdin', async () => {
    const d = await engine.preToolUse('WebFetch', { url: 'https://good.example' })
    expect(d.allowed).toBe(true)
    const payload = JSON.parse(readFileSync(seen, 'utf-8'))
    expect(payload).toMatchObject({ session_id: 'sess-1', cwd: tmp, hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://good.example' }, _marveen_runtime: 'native-api' })
  })
  it('PreToolUse: JSON deny', async () => {
    const d = await engine.preToolUse('WebFetch', { url: 'https://evil.com/x' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('egress blocked')
  })
  it('PreToolUse: exit-2 hard block with stderr reason', async () => {
    const d = await engine.preToolUse('Bash', { command: 'rm -rf /' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('no rm here')
  })
  it('PreToolUse: rewritten input is surfaced', async () => {
    const d = await engine.preToolUse('Edit', { command: 'x' })
    expect(d.allowed).toBe(true)
    expect(d.updatedInput).toEqual({ command: 'echo rewritten' })
  })
  it('UserPromptSubmit: context collected, a failing (exit 1) hook is non-blocking', async () => {
    const d = await engine.userPromptSubmit('restart now')
    expect(d.allowed).toBe(true)
    expect(d.additionalContext).toEqual(['[provenance] confirm on a verified channel'])
    expect(d.outcomes).toHaveLength(2)
  })
  it('Stop: a hook past its timeout fails open', async () => {
    const d = await engine.stop('done')
    expect(d.allowed).toBe(true)
    expect(d.outcomes[0].timedOut).toBe(true)
  }, 10_000)
  it('no hooks for an event -> allowed, no processes', async () => {
    const d = await engine.sessionStart()
    expect(d).toEqual({ allowed: true, additionalContext: [], outcomes: [] })
  })
})
