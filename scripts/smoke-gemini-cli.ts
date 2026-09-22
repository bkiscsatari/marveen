// Live smoke for the gemini-cli runtime (Phase 3). Without a Google login or
// GEMINI_API_KEY this exercises the real binary on its failure path (argv,
// .gemini/settings.json rendering, stderr auth hint -> blocked). Run from the clone root:
//   npx tsx scripts/smoke-gemini-cli.ts
import { initDatabase } from '../src/db.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../src/config.js'
import { getRuntime } from '../src/runtime/registry.js'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpec } from '../src/runtime/types.js'

initDatabase(`/tmp/marveen-agnostic-smoke-gemini-${process.pid}.db`)
const rt = await getRuntime('gemini-cli')
const spec: AgentSpec = { id: MAIN_AGENT_ID, dir: PROJECT_ROOT, role: 'background', model: 'gemini-2.5-flash', runtime: 'gemini-cli', provider: 'google', authMode: 'subscription', securityProfile: 'default', displayName: 'IcukaDev' }
console.log('[1] healthProbe ->', await rt.healthProbe(spec))
const r = await rt.run(spec, 'Reply with exactly: OK', { timeoutMs: 120_000, timeoutAsError: true, allowTools: false })
console.log('[2] run ->', { text: r.text, blocked: r.blocked, reason: r.reason?.slice(0, 220), session: r.sessionRef })
console.log('[3] .gemini/settings.json ->', readFileSync(join(PROJECT_ROOT, '.gemini', 'settings.json'), 'utf-8').slice(0, 300))
for (const f of ['claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm']) { const p = join(PROJECT_ROOT, 'store', f); if (existsSync(p)) { try { unlinkSync(p) } catch { /* best effort */ } } }
process.exit(0)
