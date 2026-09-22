// Live smoke for the minimax-cli runtime (Phase 7). With a MiniMax login
// (`mcode login`) this is a full round trip: health probe, a gated Read-tool
// run with the agent's hooks installed as a Claude-format mcode plugin, and a
// resume. Without a login it exercises the real binary's failure path (exit 3).
//   npx tsx scripts/smoke-minimax-cli.ts
import { initDatabase, getDb } from '../src/db.js'
import { getRuntime } from '../src/runtime/registry.js'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_ROOT } from '../src/config.js'
import type { AgentSpec } from '../src/runtime/types.js'

initDatabase(`/tmp/marveen-agnostic-smoke-minimax-${process.pid}.db`)
const rt = await getRuntime('minimax-cli')
const home = mkdtempSync(join(tmpdir(), 'marveen-minimax-smoke-'))
const dir = join(home, 'agents', 'probe'); mkdirSync(join(dir, '.claude'), { recursive: true })
writeFileSync(join(dir, 'CLAUDE.md'), '# Probe\nTe egy tesztügynök vagy. Röviden válaszolsz.')
writeFileSync(join(dir, 'secret-number.txt'), 'marveen-probe-42')
const gate = join(home, 'gate.sh')
writeFileSync(gate, `#!/bin/sh\nIN=$(cat)\necho "$IN" >> ${home}/hook-calls.jsonl\nexit 0\n`)
chmodSync(gate, 0o755)
writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read|Bash|WebFetch', hooks: [{ type: 'command', command: `sh ${gate}`, timeout: 10 }] }] } }))
const model = process.env.MARVEEN_SMOKE_MINIMAX_MODEL || 'minimax-m2.7-highspeed'
const spec: AgentSpec = { id: 'probe', dir, role: 'background', model, runtime: 'minimax-cli', provider: 'minimax', authMode: 'subscription', securityProfile: 'default', displayName: 'Probe' }

console.log('[1] healthProbe ->', await rt.healthProbe(spec))
const r = await rt.run(spec, 'Read the file secret-number.txt in the current directory and reply with ONLY its content.', { timeoutMs: 180_000, timeoutAsError: true, allowTools: true })
console.log('[2] tool run ->', { text: r.text, blocked: r.blocked, reason: r.reason?.slice(0, 200), tools: r.toolCalls, usage: r.usage && [r.usage.inputTokens, r.usage.outputTokens], session: r.sessionRef })
const hookCalls = existsSync(join(home, 'hook-calls.jsonl')) ? readFileSync(join(home, 'hook-calls.jsonl'), 'utf-8').trim().split('\n') : []
console.log('[2b] native hook invocations ->', hookCalls.length, hookCalls[0]?.slice(0, 200))
if (!r.blocked) {
  const r2 = await rt.run(spec, 'What number did you read a moment ago? Reply with only the number.', { resume: r.sessionRef, timeoutMs: 180_000, timeoutAsError: true, allowTools: false })
  console.log('[3] resume ->', { text: r2.text, blocked: r2.blocked, reason: r2.reason?.slice(0, 120), sameSession: r2.sessionRef === r.sessionRef })
}
console.log('[4] token_usage rows ->', getDb().prepare('SELECT agent, runtime, provider, model, input_tokens, output_tokens FROM token_usage ORDER BY id').all())
for (const f of ['claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm']) { const p = join(PROJECT_ROOT, 'store', f); if (existsSync(p)) { try { unlinkSync(p) } catch { /* best effort */ } } }
process.exit(0)
