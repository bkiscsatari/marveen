// Live smoke for the codex-cli runtime (Phase 2). Without a ChatGPT login or an
// OpenAI key this exercises the REAL binary on its failure path (argument
// parsing, stdin prompt, isolated CODEX_HOME, JSONL parsing, 401 -> blocked);
// with a login it becomes a full round trip. Run from the clone root:
//   npx tsx scripts/smoke-codex-cli.ts
import { initDatabase } from '../src/db.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../src/config.js'
import { getRuntime } from '../src/runtime/registry.js'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpec } from '../src/runtime/types.js'

const dbPath = `/tmp/marveen-agnostic-smoke-codex-${process.pid}.db`
initDatabase(dbPath)

const rt = await getRuntime('codex-cli')
const spec: AgentSpec = {
  id: MAIN_AGENT_ID, dir: PROJECT_ROOT, role: 'background', model: 'gpt-5.6-sol',
  runtime: 'codex-cli', provider: 'openai', authMode: 'subscription', securityProfile: 'default', displayName: 'IcukaDev',
}
console.log('[1] healthProbe ->', await rt.healthProbe(spec))
const r = await rt.run(spec, 'Reply with exactly: OK', { timeoutMs: 120_000, timeoutAsError: true, allowTools: false })
console.log('[2] run ->', { text: r.text, blocked: r.blocked, reason: r.reason?.slice(0, 200), session: r.sessionRef, tools: r.toolCalls?.length })
const cfg = join(PROJECT_ROOT, '.codex', 'config.toml')
console.log('[3] generated config.toml head ->\n' + readFileSync(cfg, 'utf-8').split('\n').slice(0, 8).join('\n'))
for (const f of ['claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm']) {
  const p = join(PROJECT_ROOT, 'store', f); if (existsSync(p)) { try { unlinkSync(p) } catch { /* best effort */ } }
}
process.exit(0)
