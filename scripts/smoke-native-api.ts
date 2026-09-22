// Live smoke for the native-api runtime (Phase 4) against LOCAL Ollama -- no
// API key needed. Run from the clone root:  npx tsx scripts/smoke-native-api.ts
// Exercises: healthProbe, a tool-using turn (Read a file in a temp agent dir
// with a strict researcher-style permission list + a real egress-style hook),
// resume via runtime_sessions, and the token_usage rows.
import { initDatabase, getDb } from '../src/db.js'
import { getRuntime } from '../src/runtime/registry.js'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { PROJECT_ROOT } from '../src/config.js'
import type { AgentSpec } from '../src/runtime/types.js'

initDatabase(`/tmp/marveen-agnostic-smoke-native-${process.pid}.db`)
const rt = await getRuntime('native-api')
const home = mkdtempSync(join(tmpdir(), 'marveen-native-smoke-'))
const dir = join(home, 'agents', 'probe'); mkdirSync(join(dir, '.claude'), { recursive: true })
writeFileSync(join(dir, 'CLAUDE.md'), '# Probe\nTe egy tesztügynök vagy. Röviden válaszolsz.')
writeFileSync(join(dir, 'secret-number.txt'), 'marveen-probe-42')
const gate = join(home, 'gate.sh')
writeFileSync(gate, `#!/bin/sh\nIN=$(cat)\necho "$IN" >> ${home}/hook-calls.jsonl\ncase "$IN" in *evil.com*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"egress blocked"}}';; esac\nexit 0\n`)
chmodSync(gate, 0o755)
writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'WebFetch|Bash|Read', hooks: [{ type: 'command', command: `sh ${gate}`, timeout: 10 }] }] },
  permissions: { allow: ['Read(${AGENT_DIR}/**)', 'Bash(ls:*)', 'Bash(cat:*)'], deny: ['Bash(rm:*)'] },
}))
const spec: AgentSpec = { id: 'probe', dir, role: 'background', model: 'qwen2.5:1.5b', runtime: 'native-api', provider: 'ollama', authMode: 'api', securityProfile: 'researcher', displayName: 'Probe' }

console.log('[1] healthProbe ->', await rt.healthProbe(spec))
const r = await rt.run(spec, 'Use the Read tool to read the file secret-number.txt in your working directory, then reply with ONLY its content.', { timeoutMs: 180_000, timeoutAsError: true, allowTools: true })
console.log('[2] tool run ->', { text: r.text, blocked: r.blocked, reason: r.reason, tools: r.toolCalls, usage: r.usage && [r.usage.inputTokens, r.usage.outputTokens], session: r.sessionRef })
const hookCalls = existsSync(join(home, 'hook-calls.jsonl')) ? readFileSync(join(home, 'hook-calls.jsonl'), 'utf-8').trim().split('\n').length : 0
console.log('[2b] governance hook invocations ->', hookCalls)
const r2 = await rt.run(spec, 'What number did you read a moment ago? Reply with only the number.', { resume: r.sessionRef, timeoutMs: 180_000, timeoutAsError: true, allowTools: false })
console.log('[3] resume ->', { text: r2.text, sameSession: r2.sessionRef === r.sessionRef })
const rows = getDb().prepare('SELECT agent, runtime, provider, model, input_tokens, output_tokens FROM token_usage ORDER BY id').all()
console.log('[4] token_usage rows ->', rows)
const sess = getDb().prepare('SELECT id, turns, length(messages) AS bytes FROM runtime_sessions').all()
console.log('[5] runtime_sessions ->', sess)
console.log('[6] transcript mirror ->', existsSync(join(dir, '.marveen', 'transcripts', `${r.sessionRef}.jsonl`)))
for (const f of ['claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm']) { const p = join(PROJECT_ROOT, 'store', f); if (existsSync(p)) { try { unlinkSync(p) } catch { /* best effort */ } } }
void homedir
process.exit(0)
