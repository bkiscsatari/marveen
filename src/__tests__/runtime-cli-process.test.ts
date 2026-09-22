// The shared CLI runner against FAKE binaries (small shell scripts), covering
// what no adapter test exercised before: timeout + process-group kill, a
// grandchild that keeps the stdout pipe open, early exit before stdin is read,
// a missing binary, an operator abort, and the result-beats-timeout rule.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runJsonlCli, finalizeRunResult, timeoutApology, ResumeChainSessions } from '../runtime/cli-process.js'
import { orphansToReap, liveChildren, type ChildEntry } from '../runtime/child-registry.js'
import type { AgentSpec, RunResult } from '../runtime/types.js'

const tmp = mkdtempSync(join(tmpdir(), 'marveen-cli-'))
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

function fake(name: string, body: string): string {
  const p = join(tmp, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const base = { cwd: tmp, env: process.env, label: 'test-cli', agentId: 'a' }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('runJsonlCli', () => {
  it('streams lines, passes stdin, returns the exit code', async () => {
    const bin = fake('echo.sh', 'read x; echo "{\\"got\\":\\"$x\\"}"; echo line2; exit 3')
    const lines: string[] = []
    const out = await runJsonlCli({ ...base, bin, args: [], stdin: 'hello\n', timeoutMs: 10_000, onLine: (l) => lines.push(l) })
    expect(lines).toEqual(['{"got":"hello"}', 'line2'])
    expect(out).toMatchObject({ exitCode: 3, timedOut: false, aborted: false })
  })

  it('a timeout kills the whole process group, grandchildren included', async () => {
    const pidFile = join(tmp, 'grandchild.pid')
    const bin = fake('hang.sh', `sleep 60 & echo $! > ${pidFile}; wait`)
    const started = Date.now()
    const out = await runJsonlCli({ ...base, bin, args: [], stdin: '', timeoutMs: 400, killGraceMs: 500, onLine: () => {} })
    expect(out.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(8_000)
    const gc = Number(readFileSync(pidFile, 'utf-8'))
    await new Promise((r) => setTimeout(r, 700))
    expect(alive(gc)).toBe(false)
  }, 15_000)

  it('does not hang when a grandchild keeps the stdout pipe open after the CLI exits', async () => {
    // The parent exits at once; the detached-by-shell grandchild inherits stdout.
    const bin = fake('leak.sh', 'echo first; (sleep 30) & exit 0')
    const started = Date.now()
    const out = await runJsonlCli({ ...base, bin, args: [], stdin: '', timeoutMs: 60_000, onLine: () => {} })
    expect(out.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(6_000)
  }, 15_000)

  it('survives a CLI that exits before reading stdin (EPIPE) and a missing binary', async () => {
    const bin = fake('noread.sh', 'exit 5')
    const out = await runJsonlCli({ ...base, bin, args: [], stdin: 'x'.repeat(2_000_000), timeoutMs: 10_000, onLine: () => {} })
    expect(out.exitCode).toBe(5)
    const missing = await runJsonlCli({ ...base, bin: join(tmp, 'nope'), args: [], stdin: '', timeoutMs: 10_000, onLine: () => {} })
    expect(missing.exitCode).toBeNull()
    expect(missing.stderrTail).toMatch(/ENOENT|spawn/)
  })

  it('an abort signal ends the run and says so', async () => {
    const bin = fake('long.sh', 'sleep 30')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const out = await runJsonlCli({ ...base, bin, args: [], stdin: '', timeoutMs: 60_000, signal: ac.signal, killGraceMs: 300, onLine: () => {} })
    expect(out.aborted).toBe(true)
    expect(out.timedOut).toBe(false)
  }, 15_000)

  it('registers the child while it runs and forgets it afterwards', async () => {
    const bin = fake('quick.sh', 'sleep 0.3')
    const p = runJsonlCli({ ...base, bin, args: [], stdin: '', timeoutMs: 10_000, onLine: () => {} })
    await new Promise((r) => setTimeout(r, 100))
    expect(liveChildren().some((c) => c.bin === bin)).toBe(true)
    await p
    expect(liveChildren().some((c) => c.bin === bin)).toBe(false)
  })
})

describe('finalizeRunResult', () => {
  const ok: RunResult = { text: 'answer', blocked: false }
  const empty: RunResult = { text: null, blocked: true, reason: 'no result' }
  const o = (x: Partial<{ timedOut: boolean; aborted: boolean }>) => ({ exitCode: null, stderrTail: '', timedOut: false, aborted: false, ...x })
  it('a real answer that arrived before the timer wins over the timeout', () => {
    expect(finalizeRunResult(ok, o({ timedOut: true }), { timeoutMs: 60_000 })).toEqual(ok)
  })
  it('timeout without an answer: apology text, or a structured error', () => {
    expect(finalizeRunResult(empty, o({ timedOut: true }), { timeoutMs: 120_000 }).text).toBe(timeoutApology(2))
    expect(finalizeRunResult(empty, o({ timedOut: true }), { timeoutMs: 120_000, timeoutAsError: true })).toMatchObject({ blocked: true, reason: 'timeout after 2min' })
  })
  it('an operator abort is reported as such', () => {
    expect(finalizeRunResult(ok, o({ aborted: true }), { timeoutMs: 1 })).toMatchObject({ blocked: true, reason: expect.stringMatching(/aborted/) })
  })
})

describe('ResumeChainSessions', () => {
  const spec = { id: 'x', dir: tmp, role: 'sub', model: 'm', runtime: 'claude-headless', provider: 'anthropic', authMode: 'api', securityProfile: 'default' } as AgentSpec
  it('chains resume ids, reports busy/idle/auth, and stop aborts the in-flight run', async () => {
    const seen: Array<string | undefined> = []
    let aborted = false
    const run = async (_s: AgentSpec, prompt: string, opts: { resume?: string; signal?: AbortSignal }) => {
      seen.push(opts.resume)
      if (prompt === 'slow') {
        await new Promise<void>((r) => { opts.signal?.addEventListener('abort', () => { aborted = true; r() }); setTimeout(r, 2_000) })
        return { text: null, blocked: true, reason: 'aborted' }
      }
      if (prompt === 'auth') return { text: null, blocked: true, reason: '401 not logged in' }
      return { text: 'ok', blocked: false, sessionRef: `s-${seen.length}` }
    }
    const s = new ResumeChainSessions('claude-headless', 't', run as never, (r) => /401/.test(r.reason ?? ''))
    const h = await s.spawn(spec)
    await s.send(h, 'one'); await s.send(h, 'two')
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual([undefined, 's-1'])
    await s.send(h, 'auth'); await new Promise((r) => setTimeout(r, 20))
    expect(await s.state(h)).toBe('auth')
    await s.send(h, 'slow')
    await new Promise((r) => setTimeout(r, 20))
    expect(await s.state(h)).toBe('busy')
    await s.stop(h)
    await new Promise((r) => setTimeout(r, 20))
    expect(aborted).toBe(true)
    expect(await s.state(h)).toBe('dead')
    // A new handle for the same agent continues the last known session.
    const h2 = await s.spawn(spec)
    expect(h2.sessionRef).not.toBe(h.sessionRef)
  })
})

describe('orphan reaper selection', () => {
  const e = (x: Partial<ChildEntry>): ChildEntry => ({ pid: 100, label: 'codex-cli', agentId: 'a', bin: '/usr/bin/codex', startedAt: 0, owner: 50, ...x })
  it('reaps only a live group of a dead previous owner whose cmdline still matches', () => {
    const alive = new Set([100, 101, 102, 60])
    const cmd: Record<number, string> = { 100: '/usr/bin/codex exec --json', 101: 'bash something-else', 102: '/usr/bin/codex exec' }
    const deps = { isAlive: (p: number) => alive.has(p), cmdline: (p: number) => cmd[p] ?? null }
    const picked = orphansToReap([
      e({ pid: 100 }),                 // dead owner, live, matches -> reap
      e({ pid: 101 }),                 // pid reused by another program -> keep
      e({ pid: 102, owner: 60 }),      // owner still alive -> keep
      e({ pid: 103 }),                 // already gone -> skip
      e({ pid: 104, owner: 999 }),     // owner = this process -> keep
    ], 999, deps)
    expect(picked.map((x) => x.pid)).toEqual([100])
  })
})

it('fixture sanity: the temp dir exists', () => { expect(existsSync(tmp)).toBe(true) })
