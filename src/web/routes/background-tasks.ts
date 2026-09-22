import { randomBytes } from 'node:crypto'
import { execSync, execFileSync } from 'node:child_process'
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
import { resolveFromPath } from '../../platform.js'
import { APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { shadowRoute, routeForRun } from '../model-routing.js'
import type { RouteContext } from './types.js'
import { bgRuntimeKind } from '../../runtime/flags.js'
import { getRuntime } from '../../runtime/registry.js'
import { buildAgentSpec } from '../../runtime/agent-spec.js'
import type { RuntimeKind } from '../../runtime/types.js'

export { bgRuntimeKind }

// Phase 1 (agent-agnostic): MARVEEN_BG_RUNTIME=<runtime> executes background
// tasks through a runtime adapter instead of `claude -p` in a tmux session.
// The task row's tmux_session column then carries a `rt:<kind>:<id>` marker
// (never a real tmux name), and live output comes from the adapter's
// onProgress stream instead of capture-pane. Default: the legacy path.
export function runtimeSessionRef(kind: RuntimeKind, id: string): string {
  return `rt:${kind}:${id}`
}

export function isRuntimeBackedSession(session: string | null | undefined): boolean {
  return typeof session === 'string' && session.startsWith('rt:')
}

function runtimeTaskId(session: string): string {
  return session.split(':')[2] ?? ''
}

// id -> live output buffer for runtime-backed tasks still running in THIS process.
const runtimeLive = new Map<string, { output: string }>()

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 30 * 60 * 1000

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function bgSessionName(id: string): string {
  return `bg-${id}`
}

function isBgSessionAlive(session: string): boolean {
  if (isRuntimeBackedSession(session)) return runtimeLive.has(runtimeTaskId(session))
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { timeout: 3000, encoding: 'utf-8' })
    return out.split('\n').some(l => l.trim() === session)
  } catch {
    return false
  }
}

function captureSession(session: string): string | null {
  if (isRuntimeBackedSession(session)) return runtimeLive.get(runtimeTaskId(session))?.output ?? null
  try {
    return execFileSync(TMUX, ['capture-pane', '-t', session, '-p', '-S', '-500'], { timeout: 5000, encoding: 'utf-8' })
  } catch {
    return null
  }
}

function killSession(session: string): void {
  // A runtime-backed run is bounded by its own timeout; nothing to kill here.
  if (isRuntimeBackedSession(session)) return
  try {
    execFileSync(TMUX, ['kill-session', '-t', session], { timeout: 3000 })
  } catch { /* already dead */ }
}

function spawnViaRuntime(id: string, agentId: string, prompt: string, kind: RuntimeKind): BackgroundTask | { error: string } {
  const ref = runtimeSessionRef(kind, id)
  const task = createBackgroundTaskAtomic(id, agentId, prompt, ref, MAX_CONCURRENT)
  if (!task) {
    return { error: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }
  const live = { output: '' }
  runtimeLive.set(id, live)
  void (async () => {
    try {
      let spec = buildAgentSpec(agentId, 'background')
      // Jev B1 (MODEL_ROUTING=background): a fresh process, so the suggestion
      // can become THIS run's (runtime, provider, model) without a respawn.
      const override = await routeForRun({ source: 'background', agent: agentId, text: prompt, taskRef: id, current: { runtime: spec.runtime, provider: spec.provider, model: spec.model } })
      if (override) spec = { ...spec, runtime: override.runtime, provider: override.provider, model: override.model }
      const rt = await getRuntime(override ? override.runtime : kind)
      const r = await rt.run(spec, prompt, {
        allowTools: true,
        timeoutMs: TIMEOUT_MS,
        timeoutAsError: true,
        onProgress: (chunk) => { live.output = (live.output + chunk).slice(-20_000) },
      })
      const status = r.blocked ? (/timeout/i.test(r.reason ?? '') ? 'timeout' : 'failed') : 'done'
      finishBackgroundTask(id, status, r.text ?? (r.reason ? `(${r.reason})` : '(no output)'))
      logger.info({ id, agentId, kind, status, costUsd: r.usage?.costUsd }, 'Background task finished via runtime')
    } catch (err) {
      finishBackgroundTask(id, 'failed', `(runtime error: ${(err as Error).message})`)
      logger.error({ err, id, agentId, kind }, 'Background task runtime failure')
    } finally {
      runtimeLive.delete(id)
    }
  })()
  logger.info({ id, agentId, kind, prompt: prompt.slice(0, 100) }, 'Background task started via runtime')
  return task
}

export function spawnBackgroundTask(agentId: string, prompt: string): BackgroundTask | { error: string } {
  const id = randomBytes(4).toString('hex').toUpperCase()
  const kind = bgRuntimeKind()
  if (kind !== 'legacy-tmux') return spawnViaRuntime(id, agentId, prompt, kind)
  const session = bgSessionName(id)

  const task = createBackgroundTaskAtomic(id, agentId, prompt, session, MAX_CONCURRENT)
  if (!task) {
    return { error: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }

  const shellCmd = [
    `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    `${CLAUDE} -p "$BG_PROMPT" --output-format text 2>&1`,
  ].join(' && ')

  try {
    execFileSync(TMUX, [
      'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
      `${shellCmd}; echo '___BG_DONE___'; sleep 5`,
    ], {
      timeout: 5000,
      env: { ...process.env, BG_PROMPT: prompt },
    })
  } catch (err) {
    logger.error({ err, id, session }, 'Failed to spawn background task tmux session')
    finishBackgroundTask(id, 'failed', '(spawn failed)')
    return { error: 'Nem sikerült elindítani a háttérfeladatot' }
  }

  logger.info({ id, agentId, session, prompt: prompt.slice(0, 100) }, 'Background task started')
  // Jev model-routing shadow (B0). A background task is a fresh `claude -p`
  // process, so this is the first place a suggestion could later become a
  // per-task --model flag (B1) without respawning anything.
  shadowRoute({ source: 'background', agent: agentId, text: prompt, taskRef: id })

  setTimeout(() => checkAndFinalize(id), TIMEOUT_MS)
  pollUntilDone(id)

  return task
}

function pollUntilDone(id: string): void {
  const interval = setInterval(() => {
    const task = getBackgroundTask(id)
    if (!task || task.status !== 'running') {
      clearInterval(interval)
      return
    }

    const session = task.tmux_session
    if (!session) { clearInterval(interval); return }

    if (!isBgSessionAlive(session)) {
      const output = '(session ended)'
      finishBackgroundTask(id, 'done', output)
      logger.info({ id }, 'Background task session ended')
      clearInterval(interval)
      return
    }

    const pane = captureSession(session)
    if (pane && pane.includes('___BG_DONE___')) {
      const output = pane.replace(/___BG_DONE___[\s\S]*$/, '').trim()
      finishBackgroundTask(id, 'done', output)
      killSession(session)
      logger.info({ id }, 'Background task completed')
      clearInterval(interval)
    }
  }, 10_000)
}

function checkAndFinalize(id: string): void {
  const task = getBackgroundTask(id)
  if (!task || task.status !== 'running') return

  const session = task.tmux_session
  const output = session ? captureSession(session) : null
  finishBackgroundTask(id, 'timeout', output?.trim() || '(timeout)')
  if (session) killSession(session)
  logger.warn({ id }, 'Background task timed out after 30 minutes')
}

export function sweepOrphanedBackgroundTasks(): void {
  const running = getRunningBackgroundTasks()
  let orphaned = 0
  for (const task of running) {
    if (!task.tmux_session || !isBgSessionAlive(task.tmux_session)) {
      const output = task.tmux_session ? captureSession(task.tmux_session) : null
      finishBackgroundTask(task.id, 'failed', output?.trim() || '(orphaned on restart)')
      orphaned++
    } else {
      setTimeout(() => checkAndFinalize(task.id), TIMEOUT_MS)
      pollUntilDone(task.id)
    }
  }
  if (orphaned) logger.info({ orphaned }, 'Swept orphaned background tasks on startup')
}

const TASK_ID_RE = /^\/api\/background-tasks\/([A-F0-9]{8})$/

export async function tryHandleBackgroundTasks(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/background-tasks' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id: string; prompt: string }
    if (!data.prompt?.trim()) {
      json(res, { error: 'Prompt megadása kötelező' }, 400)
      return true
    }
    if (!data.agent_id?.trim()) {
      json(res, { error: 'Agent ID megadása kötelező' }, 400)
      return true
    }

    const result = spawnBackgroundTask(data.agent_id.trim(), data.prompt.trim())
    if ('error' in result) {
      json(res, { error: result.error }, 429)
      return true
    }
    json(res, result, 201)
    return true
  }

  if (path === '/api/background-tasks' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || undefined
    const all = url.searchParams.get('all') === 'true'
    const tasks = getBackgroundTasks(agentId, all)
    const formatted = tasks.map(t => ({
      ...t,
      started_label: new Date(t.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: t.finished_at ? new Date(t.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    }))
    json(res, formatted)
    return true
  }

  const taskMatch = path.match(TASK_ID_RE)
  if (taskMatch && method === 'GET') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }

    let liveOutput: string | null = null
    if (task.status === 'running' && task.tmux_session) {
      liveOutput = captureSession(task.tmux_session)
    }

    json(res, {
      ...task,
      liveOutput,
      started_label: new Date(task.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: task.finished_at ? new Date(task.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    })
    return true
  }

  if (taskMatch && method === 'DELETE') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
    const output = task.tmux_session ? captureSession(task.tmux_session) : null
    if (task.status === 'running' && task.tmux_session) {
      killSession(task.tmux_session)
    }
    finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
    json(res, { ok: true })
    return true
  }

  return false
}
