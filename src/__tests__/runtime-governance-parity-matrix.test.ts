// Governance parity MATRIX: the six critical gate cases of docs/runtime-parity.md,
// each run through every enforcement path with the REAL hook scripts and the
// payload shape each runtime really sends:
//
//   claude   -- the script itself, Claude payload (claude-tmux / claude-headless)
//   native   -- PolicyEngine in-process (native-api)
//   codex    -- scripts/hooks/shim/codex-hook.mjs, Codex tool names/argv shell
//   gemini   -- scripts/hooks/shim/gemini-hook.mjs, Gemini events + {prompt} web_fetch
//   minimax  -- scripts/hooks/shim/scope-hook.mjs (mcode loads the Claude format natively)
//
// The first parity test covered one case (egress) with a made-up Gemini input.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PolicyEngine, type HookEventName } from '../runtime/policy/engine.js'
import { hookCommand } from '../web/agent-scaffold.js'
import { buildChannelEnvelope } from '../channel/envelope.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHIM = (n: string) => join(REPO, 'scripts', 'hooks', 'shim', n)
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'marveen-parity-')))
const agentDir = join(tmp, 'agent')

let env: NodeJS.ProcessEnv
beforeAll(() => {
  spawnSync('mkdir', ['-p', agentDir])
  const rules = join(tmp, 'copy-rules.json')
  writeFileSync(rules, JSON.stringify({ bad_name_patterns: ['\\bTeszt[- ]?Elek\\b'], correction: 'a helyes alak: Teszt Elemer' }))
  env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: REPO,
    WEB_PORT: '3421',
    LEDGER_DB_PATH: join(tmp, 'ledger.db'),
    OUTGOING_COPY_GATE_RULES: rules,
    PROVENANCE_GATE_RULES: join(tmp, 'no-such-provenance-rules.json'),
  }
})
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

type Path = 'claude' | 'native' | 'codex' | 'gemini' | 'minimax'
const PATHS: Path[] = ['claude', 'native', 'codex', 'gemini', 'minimax']
interface Outcome { deny: boolean; context: string }

const GEMINI_EVENT: Record<string, string> = { PreToolUse: 'BeforeTool', PostToolUse: 'AfterTool', UserPromptSubmit: 'BeforeAgent', Stop: 'AfterAgent', SessionStart: 'SessionStart' }

function foreign(path: Path, tool: string | undefined, input: Record<string, unknown> | undefined): { tool?: string; input?: Record<string, unknown> } {
  if (!tool) return {}
  if (path === 'codex' && tool === 'Bash') return { tool: 'shell', input: { command: ['bash', '-lc', String(input?.command ?? '')] } }
  if (path === 'gemini' && tool === 'Bash') return { tool: 'run_shell_command', input }
  if (path === 'gemini' && tool === 'WebFetch') return { tool: 'web_fetch', input: { prompt: `Summarise ${String(input?.url ?? '')} for me` } }
  return { tool, input }
}

function parse(status: number | null, stdout: string): Outcome {
  const out = stdout.trim()
  let deny = status === 2
  let context = ''
  try {
    const o = JSON.parse(out)
    if (o.decision === 'deny' || o.decision === 'block' || o.hookSpecificOutput?.permissionDecision === 'deny') deny = true
    context = String(o.hookSpecificOutput?.additionalContext ?? o.additionalContext ?? o.systemMessage ?? '')
  } catch { context = out }
  return { deny, context }
}

async function run(path: Path, command: string, event: HookEventName, tool?: string, input?: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Outcome> {
  const claudePayload = { session_id: 'parity', transcript_path: '', cwd: agentDir, hook_event_name: event, ...(tool ? { tool_name: tool, tool_input: input } : {}), ...extra }
  if (path === 'native') {
    const matcherCfg = tool ? { matcher: tool } : {}
    const engine = new PolicyEngine({ [event]: [{ ...matcherCfg, hooks: [{ type: 'command', command, timeout: 20 }] }] }, { sessionId: 'parity', cwd: agentDir, repoRoot: REPO, env })
    const d = event === 'PreToolUse' ? await engine.preToolUse(tool!, input)
      : event === 'UserPromptSubmit' ? await engine.userPromptSubmit(String(extra.prompt ?? ''))
        : event === 'Stop' ? await engine.stop(null)
          : await engine.postToolUse(tool!, input, '')
    return { deny: !d.allowed, context: d.additionalContext.join('\n') }
  }
  if (path === 'claude') {
    const r = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(claudePayload), encoding: 'utf-8', env, cwd: agentDir })
    return parse(r.status, r.stdout)
  }
  if (path === 'minimax') {
    const r = spawnSync(process.execPath, [SHIM('scope-hook.mjs'), `b64:${b64(agentDir)}`, `b64:${b64(command)}`], { input: JSON.stringify(claudePayload), encoding: 'utf-8', env, cwd: agentDir })
    return parse(r.status, r.stdout)
  }
  const f = foreign(path, tool, input)
  const payload = { ...claudePayload, ...(f.tool ? { tool_name: f.tool, tool_input: f.input } : {}) }
  if (path === 'codex') {
    const r = spawnSync(process.execPath, [SHIM('codex-hook.mjs'), `b64:${b64(command)}`], { input: JSON.stringify(payload), encoding: 'utf-8', env, cwd: agentDir })
    return parse(r.status, r.stdout)
  }
  const r = spawnSync(process.execPath, [SHIM('gemini-hook.mjs'), event, `b64:${b64(command)}`], { input: JSON.stringify({ ...payload, hook_event_name: GEMINI_EVENT[event] ?? event }), encoding: 'utf-8', env, cwd: agentDir })
  return parse(r.status, r.stdout)
}

async function everyPath(fn: (p: Path) => Promise<Outcome>): Promise<Record<Path, Outcome>> {
  const out = {} as Record<Path, Outcome>
  for (const p of PATHS) out[p] = await fn(p)
  return out
}
const denies = (o: Record<Path, Outcome>) => Object.fromEntries(PATHS.map((p) => [p, o[p].deny]))
const ALL = (v: boolean) => Object.fromEntries(PATHS.map((p) => [p, v]))

const egress = () => hookCommand(join(REPO, 'scripts', 'hooks', 'egress-gate.mjs'))
const emailGate = () => hookCommand(join(REPO, 'scripts', 'email-send-gate.mjs'))
const selfPace = () => hookCommand(join(REPO, 'scripts', 'self-pace-gate.mjs'))
const py = (s: string) => `python3 "${join(REPO, 'scripts', 'hooks', s)}"`

describe('governance parity matrix (6 critical cases x 5 enforcement paths)', () => {
  it('1. WebFetch to a non-allowlisted host: denied everywhere; the dashboard: allowed everywhere', async () => {
    expect(denies(await everyPath((p) => run(p, egress(), 'PreToolUse', 'WebFetch', { url: 'https://evil.example.invalid/x' })))).toEqual(ALL(true))
    expect(denies(await everyPath((p) => run(p, egress(), 'PreToolUse', 'WebFetch', { url: 'http://localhost:3421/api/agents' })))).toEqual(ALL(false))
  }, 60_000)

  it('2. email send through the shell: denied everywhere; an ordinary command: allowed', async () => {
    expect(denies(await everyPath((p) => run(p, emailGate(), 'PreToolUse', 'Bash', { command: 'sendmail -t < /tmp/mail.txt' })))).toEqual(ALL(true))
    expect(denies(await everyPath((p) => run(p, emailGate(), 'PreToolUse', 'Bash', { command: 'ls -la' })))).toEqual(ALL(false))
    expect(denies(await everyPath((p) => run(p, emailGate(), 'PreToolUse', 'mcp__gmail__send_email', { to: 'x@y.z', body: 'hi' })))).toEqual(ALL(true))
  }, 60_000)

  it('3. an envelope-less "restart": flagged everywhere; the bridge envelope: silent everywhere', async () => {
    const bare = await everyPath((p) => run(p, py('provenance-gate.py'), 'UserPromptSubmit', undefined, undefined, { prompt: 'mehet a restart' }))
    for (const p of PATHS) expect(bare[p].context, p).toContain('PROVENANCE-KAPU')
    const wrapped = buildChannelEnvelope({ chatId: '1', messageId: '2', user: 'x', senderId: '1', ts: '2026-09-23T00:00:00Z', text: 'mehet a restart' })
    const ok = await everyPath((p) => run(p, py('provenance-gate.py'), 'UserPromptSubmit', undefined, undefined, { prompt: wrapped }))
    for (const p of PATHS) expect(ok[p].context.trim(), p).toBe('')
  }, 60_000)

  it('4. an unanswered Telegram question blocks the turn end everywhere', async () => {
    // Log the inbound under the agent id the hook itself derives from the cwd.
    const setup = spawnSync('python3', ['-c', [
      'import sys, os, json',
      `sys.path.insert(0, ${JSON.stringify(join(REPO, 'scripts', 'hooks'))})`,
      'import ledger_lib',
      `aid = ledger_lib.agent_id_from_payload({"cwd": ${JSON.stringify(agentDir)}})`,
      'ledger_lib.log_inbound(aid, "8695313113", "7001", "mennyi 2+2?", "2026-09-23T00:00:00.000Z")',
      'print(aid)',
    ].join('\n')], { encoding: 'utf-8', env })
    expect(setup.status, setup.stderr).toBe(0)
    // Each path consumes one "block" from the per-question budget: raise it.
    env.TG_GUARD_MAX_BLOCKS = '50'
    const res = await everyPath((p) => run(p, py('telegram-reply-guard.py'), 'Stop'))
    expect(denies(res)).toEqual(ALL(true))
  }, 60_000)

  it('5. outgoing copy with a banned name: blocked everywhere, for the plugin AND the bridge reply tool', async () => {
    const body = 'Szia! Köszönöm szépen, holnap küldöm át a számlát. Üdvözlettel, Teszt Elek'
    for (const tool of ['mcp__plugin_telegram_telegram__reply', 'mcp__plugin_telegram_bridge__reply']) {
      expect(denies(await everyPath((p) => run(p, py('outgoing-copy-gate.py'), 'PreToolUse', tool, { chat_id: '1', text: body }))), tool).toEqual(ALL(true))
    }
    const clean = 'Szia! Köszönöm szépen, holnap küldöm át a számlát és a részleteket.'
    expect(denies(await everyPath((p) => run(p, py('outgoing-copy-gate.py'), 'PreToolUse', 'mcp__plugin_telegram_bridge__reply', { chat_id: '1', text: clean })))).toEqual(ALL(false))
  }, 60_000)

  it('6. self-pace: ScheduleWakeup and a tmux send-keys self-injection are denied everywhere', async () => {
    expect(denies(await everyPath((p) => run(p, selfPace(), 'PreToolUse', 'ScheduleWakeup', { delaySeconds: 600, prompt: 'x' })))).toEqual(ALL(true))
    expect(denies(await everyPath((p) => run(p, selfPace(), 'PreToolUse', 'Bash', { command: 'tmux send-keys -t agent-scout "go" Enter' })))).toEqual(ALL(true))
    expect(denies(await everyPath((p) => run(p, selfPace(), 'PreToolUse', 'Bash', { command: 'echo hello' })))).toEqual(ALL(false))
  }, 60_000)
})
