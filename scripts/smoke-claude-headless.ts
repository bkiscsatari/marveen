// Live smoke for the claude-headless runtime (Phase 1). Run from the clone root:
//   MARVEEN_WORKER_RUNTIME=claude-headless MARVEEN_BG_RUNTIME=claude-headless \
//   MARVEEN_WORKER_MODEL=claude-haiku-4-5-20251001 npx tsx scripts/smoke-claude-headless.ts
// Uses a THROWAWAY sqlite file so the checkout never grows a live-install marker.
import { initDatabase, getDb, getBackgroundTask } from '../src/db.js'
import { MAIN_AGENT_ID } from '../src/config.js'
import { getRuntime } from '../src/runtime/registry.js'
import { headlessWorkerSpec } from '../src/runtime/claude-headless.js'
import { runAgent } from '../src/agent.js'
import { spawnBackgroundTask } from '../src/web/routes/background-tasks.js'

const dbPath = `/tmp/marveen-agnostic-smoke-${process.pid}.db`
initDatabase(dbPath)

const rt = await getRuntime('claude-headless')
const spec = { ...headlessWorkerSpec(), model: 'claude-haiku-4-5-20251001' }

console.log('[1] healthProbe ->', await rt.healthProbe(spec))

const r = await rt.run(spec, 'Válaszolj pontosan ennyit, semmi mást: PING', { timeoutMs: 120_000, timeoutAsError: true })
console.log('[2] run ->', { text: r.text, blocked: r.blocked, reason: r.reason, cost: r.usage?.costUsd, session: r.sessionRef, tokens: [r.usage?.inputTokens, r.usage?.outputTokens] })

const r2 = await rt.run(spec, 'Mit kértem az előbb? Csak a szót írd le.', { resume: r.sessionRef, timeoutMs: 120_000, timeoutAsError: true })
console.log('[3] resume ->', { text: r2.text, sameSession: r2.sessionRef === r.sessionRef })

const a = await runAgent('Írj egy egysoros magyar köszöntést, semmi mást.', undefined, undefined, false, undefined, undefined, { timeoutMs: 120_000 })
console.log('[4] runAgent(headless) ->', a)

const t = spawnBackgroundTask(MAIN_AGENT_ID, 'Reply with exactly: BG-OK')
console.log('[5] bg spawned ->', 'error' in t ? t : { id: t.id, session: t.tmux_session })
if (!('error' in t)) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const cur = getBackgroundTask(t.id)
    if (cur && cur.status !== 'running') { console.log('[5] bg finished ->', { status: cur.status, output: cur.output }); break }
    await new Promise((res) => setTimeout(res, 2000))
  }
}

// Some import-path module lazily opens the DEFAULT store db; remove that marker so the
// vitest live-install gate (assert-not-live-install) keeps opening in this checkout.
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../src/config.js'
for (const f of ['claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm']) {
  const p = join(PROJECT_ROOT, 'store', f)
  if (existsSync(p)) { try { unlinkSync(p) } catch { /* best effort */ } }
}
const rows = getDb().prepare('SELECT agent, runtime, provider, model, input_tokens, output_tokens, cost_usd FROM token_usage ORDER BY id').all()
console.log('[6] token_usage rows ->', rows)
process.exit(0)
