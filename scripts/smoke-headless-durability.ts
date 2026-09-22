// Live durability smoke for headless session agents on a REAL runtime
// (minimax-cli, subscription login), without the dashboard:
//
//   phase a: start a probe agent, send a turn that runs for a while, and
//            hard-exit this process while the mcode child is running (a
//            dashboard crash). The child's process group survives, as it
//            would under KillMode=process.
//   phase b: reap the orphan from the child registry (it must be found and
//            killed), start the agent again: the journal replays the
//            interrupted turn WITH the interruption note, and it completes.
//
//   npx tsx scripts/smoke-headless-durability.ts a && npx tsx scripts/smoke-headless-durability.ts b
// State lives in /tmp/marveen-headless-durability (removed at the end of b).
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../src/db.js'
import { initChildRegistry, reapOrphanedChildren, liveChildren } from '../src/runtime/child-registry.js'
import { _setHeadlessDepsForTest, startHeadlessAgent, sendToHeadlessAgent, headlessInfo, readJournal, INTERRUPTED_NOTE } from '../src/web/headless-agents.js'
import { pluginNameFor, minimaxDataDir } from '../src/runtime/minimax-cli.js'
import { SERVICE_ID } from '../src/config.js'
import type { AgentSpec } from '../src/runtime/types.js'

const BASE = '/tmp/marveen-headless-durability'
const store = join(BASE, 'store')
const dir = join(BASE, 'agents', 'durprobe')
mkdirSync(store, { recursive: true }); mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'CLAUDE.md'), '# Probe\nTesztügynök vagy. Pontosan azt csinálod, amit kérnek, röviden.')
initDatabase(join(BASE, 'smoke.db'))
const spec: AgentSpec = { id: 'durprobe', dir, role: 'sub', model: process.env.MARVEEN_SMOKE_MINIMAX_MODEL || 'minimax-m2.7-highspeed', runtime: 'minimax-cli', provider: 'minimax', authMode: 'subscription', securityProfile: 'default', displayName: 'Probe', permissionMode: 'permissive' }
_setHeadlessDepsForTest({ buildSpec: () => spec, storeDir: () => store, notifyMain: (t) => console.log('[notify]', t.slice(0, 160)) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const phase = process.argv[2]

if (phase === 'a') {
  initChildRegistry(store)
  console.log('[a] start ->', await startHeadlessAgent('durprobe', { fresh: true }))
  console.log('[a] send ->', await sendToHeadlessAgent('durprobe', 'Run the shell command `sleep 25 && echo slept` with your shell tool, then reply with exactly: DURABLE-OK'))
  for (let i = 0; i < 60 && !liveChildren().length; i++) await sleep(250)
  await sleep(4000)
  console.log('[a] child running ->', liveChildren().map((c) => ({ pid: c.pid, label: c.label })))
  console.log('[a] journal ->', readJournal(store, 'durprobe').map((t) => t.state))
  console.log('[a] hard exit (simulated dashboard crash)')
  process.exit(137)
}

if (phase === 'b') {
  const before = JSON.parse(readFileSync(join(store, 'runtime-children.json'), 'utf-8')) as Array<{ pid: number }>
  const alive = (p: number) => { try { process.kill(p, 0); return true } catch { return false } }
  const cmd = (p: number) => { try { return readFileSync(`/proc/${p}/cmdline`, 'utf-8').replace(/\0/g, ' ').slice(0, 80) } catch { return null } }
  console.log('[b] recorded children ->', before.map((c) => ({ pid: c.pid, alive: alive(c.pid), cmdline: cmd(c.pid) })))
  console.log('[b] reaped ->', reapOrphanedChildren(store))
  await sleep(6000)
  console.log('[b] after reap alive ->', before.map((c) => alive(c.pid)))
  initChildRegistry(store)
  const j = readJournal(store, 'durprobe')
  console.log('[b] journal before restart ->', j.map((t) => t.state))
  console.log('[b] start ->', await startHeadlessAgent('durprobe'))
  for (let i = 0; i < 240; i++) {
    const info = headlessInfo('durprobe')
    if (info && info.turns >= 1 && info.state !== 'busy' && info.queued === 0) break
    await sleep(1000)
  }
  const log = readFileSync(join(store, 'headless-agents', 'durprobe.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { dir: string; text: string })
  const replayIn = [...log].reverse().find((l) => l.dir === 'in') // the replayed turn, not phase a's original
  console.log('[b] replayed with note ->', !!replayIn?.text.startsWith(INTERRUPTED_NOTE.slice(0, 40)))
  console.log('[b] outcome ->', log.filter((l) => l.dir === 'out' || l.dir === 'error').map((l) => `${l.dir}: ${l.text.slice(0, 120)}`))
  console.log('[b] journal after ->', readJournal(store, 'durprobe'))
  console.log('[b] info ->', headlessInfo('durprobe'))
  const pd = join(minimaxDataDir(), 'plugins', pluginNameFor('durprobe', SERVICE_ID))
  if (existsSync(pd)) rmSync(pd, { recursive: true, force: true })
  rmSync(BASE, { recursive: true, force: true })
  process.exit(0)
}
console.log('usage: smoke-headless-durability.ts a|b')
