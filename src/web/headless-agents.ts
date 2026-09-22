// Headless session agents: a long-lived fleet member whose runtime is NOT the
// interactive Claude Code TUI in tmux (minimax-cli, codex-cli, gemini-cli,
// native-api, claude-headless), or whose model is chosen per task by the Jev
// router ("Jev-routed").
//
// Why this exists (2026-09-22): the whole fleet plumbing -- startAgentProcess,
// isAgentRunning, sendPromptToSession, the message router's readiness gate,
// the kanban dispatch, the desired-state reconciler -- was written against a
// tmux session name. The runtime adapters in src/runtime/ could already run a
// turn on every CLI, but nothing in the dashboard drove a sub-agent through
// them: setting `runtime: minimax-cli` in agent-config.json still launched a
// Claude TUI. This module is the missing piece. It is deliberately built on
// `AgentRuntime.run()` (one turn, with `resume`) rather than the adapters'
// spawn/send/state trio, because a session loop that owns its own queue,
// resume token and turn log is what the dashboard needs to show, persist and
// restart -- and run() is the one method every adapter implements identically.
//
// Contract with the tmux world (agent-process.ts branches to here):
//   - "running"  = an entry exists in `entries` (the operator started it, or
//                  the reconciler restarted it after a dashboard restart).
//   - "ready"    = state is idle (no turn in flight). A busy agent keeps the
//                  message pending in the DB, exactly as a busy pane does, so
//                  nothing is lost on a dashboard restart mid-turn.
//   - "send"     = one queued turn: runtime.run(spec, text, { resume }).
//                  The agent answers the way every sub-agent does today --
//                  through the dashboard API from inside its own tools -- so
//                  the rest of the fleet cannot tell the difference.
//   - the resume token survives restarts in store/headless-agents.json; a
//     `fresh` start drops it. Each turn is appended to
//     store/headless-agents/<name>.jsonl (the "conversation" of a headless
//     agent, since it has no Claude transcript to read).
//
// Jev-routed agents (agent-config.json `modelRouting: "jev"`, MODEL_ROUTING=all):
// every delivered task is classified first; the profile map turns the profile
// into a (runtime, provider, model) target, and when hysteresis allows the
// switch the NEXT turn runs there on a fresh session. A routed agent is always
// headless: a target that names claude-tmux is run as claude-headless (same
// Claude subscription, no TUI), so the loop never has to respawn a pane.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  readAgentModelRouting,
  readAgentRemoteHost,
  resolveAgentRuntimeSpec,
  readModelProfileMap,
  resolveModelId,
} from './agent-config.js'
import { buildAgentSpec } from '../runtime/agent-spec.js'
import { getRuntime, RuntimeNotAvailableError } from '../runtime/registry.js'
import type { AgentRuntime, AgentSpec, ProviderKind, RunResult, RuntimeKind } from '../runtime/types.js'
import type { PaneState } from '../pane-state.js'
import { resolveProfileTarget, type ModelProfileId } from '../model-profiles.js'
import { defaultAuthModeFor, defaultRuntimeFor, inferProvider } from '../runtime/resolve-spec.js'

export type HeadlessState = 'idle' | 'busy' | 'blocked' | 'auth'

export interface HeadlessTurnLogEntry {
  ts: number
  dir: 'in' | 'out' | 'switch' | 'error'
  runtime: RuntimeKind
  model: string
  text: string
  blocked?: boolean
  reason?: string
  profile?: string | null
}

interface Entry {
  name: string
  spec: AgentSpec
  runtime: AgentRuntime
  routed: boolean
  profile: ModelProfileId | null
  /** Epoch seconds, like tmux #{session_created}. */
  startedAt: number
  resumeToken: string | null
  chain: Promise<unknown>
  inFlight: number
  queued: number
  state: HeadlessState
  lastResult: RunResult | null
  lastTurnAt: number | null
  lastError: string | null
  turns: number
  /** One alert per blocked/auth episode, not one per turn. */
  alertedFor: HeadlessState | null
}

interface PersistedAgent {
  runtime: RuntimeKind
  provider: ProviderKind
  model: string
  resumeToken: string | null
  startedAt: number
  profile: ModelProfileId | null
  routed: boolean
}
interface PersistedFile { version: 1; agents: Record<string, PersistedAgent> }

const entries = new Map<string, Entry>()

// Dependency seams for tests and for callers that must not import the whole
// routing/db stack. Production wiring is installed lazily on first use.
export type RoutedTarget = { runtime: RuntimeKind; provider: ProviderKind; model: string }

interface Deps {
  /** The agent's spec from its directory (buildAgentSpec in production). */
  buildSpec: (name: string) => AgentSpec
  readRouting: (name: string) => 'jev' | null
  /** Where a routed agent starts before its first task (the routine_lowcost target). */
  initialRoutedTarget: () => { ok: true } & RoutedTarget | { ok: false; error: string }
  routeForTurn: (input: {
    agent: string; text: string; taskRef: string
    current: RoutedTarget
    currentProfile: ModelProfileId | null
  }) => Promise<({ profile: string } & RoutedTarget) | null>
  routingAll: () => boolean
  notifyMain: (text: string) => void
  storeDir: () => string
  now: () => number
}

let deps: Deps | null = null

async function prodDeps(): Promise<Deps> {
  const routing = await import('./model-routing.js')
  const db = await import('../db.js')
  return {
    buildSpec: (name) => buildAgentSpec(name, 'sub'),
    readRouting: (name) => { try { return readAgentModelRouting(name) } catch { return null } },
    initialRoutedTarget,
    routeForTurn: async (input) => routing.routeForRun({
      source: 'inter_agent', agent: input.agent, text: input.text, taskRef: input.taskRef,
      current: input.current, currentProfile: input.currentProfile,
    }),
    routingAll: () => routing.routingMode() === 'all',
    notifyMain: (text) => { try { db.createAgentMessage('system', MAIN_AGENT_ID, text) } catch (err) { logger.warn({ err }, 'headless-agents: could not notify the main agent') } },
    storeDir: () => STORE_DIR,
    now: () => Date.now(),
  }
}

async function getDeps(): Promise<Deps> {
  if (!deps) deps = await prodDeps()
  return deps
}

/** Test hook: replace the production seams (and forget every running entry). */
export function _setHeadlessDepsForTest(d: Partial<Deps> | null): void {
  entries.clear()
  headlessCache.clear()
  if (d === null) { deps = null; return }
  const base: Deps = {
    buildSpec: (name) => buildAgentSpec(name, 'sub'),
    readRouting: () => null,
    initialRoutedTarget: () => ({ ok: false, error: 'no profile map in test' }),
    routeForTurn: async () => null,
    routingAll: () => false,
    notifyMain: () => {},
    storeDir: () => STORE_DIR,
    now: () => Date.now(),
  }
  deps = { ...base, ...d }
}

// ---- classification -----------------------------------------------------------

// isHeadlessAgent is called from every liveness loop on every tick; the config
// read behind it is two small JSON files, but a 3 s cache keeps the loops from
// stat-ing them dozens of times a second. Writers (the PUT route) call
// invalidateHeadlessCache() so a change is visible on the next tick.
const headlessCache = new Map<string, { at: number; value: boolean }>()
const HEADLESS_CACHE_MS = 3000

export function invalidateHeadlessCache(name?: string): void {
  if (name) headlessCache.delete(name)
  else headlessCache.clear()
}

/**
 * True when this sub-agent is driven by the headless session loop instead of a
 * tmux pane: its resolved runtime is not claude-tmux, or it is Jev-routed.
 * The main agent and remote (ssh) agents are never headless here -- the main
 * agent's non-tmux path is the channel bridge (src/channel/service.ts).
 */
export function isHeadlessAgent(name: string): boolean {
  if (!name || name === MAIN_AGENT_ID) return false
  const hit = headlessCache.get(name)
  const now = Date.now()
  if (hit && now - hit.at < HEADLESS_CACHE_MS) return hit.value
  let value = false
  try {
    if (readAgentRemoteHost(name)) value = false
    else if (readAgentModelRouting(name) === 'jev') value = true
    else value = resolveAgentRuntimeSpec(name, 'sub').runtime !== 'claude-tmux'
  } catch {
    value = false
  }
  headlessCache.set(name, { at: now, value })
  return value
}

export function isRoutedHeadlessAgent(name: string): boolean {
  if (!isHeadlessAgent(name)) return false
  try { return readAgentModelRouting(name) === 'jev' } catch { return false }
}

/** `agent-<name>` -> name when that agent is headless; null otherwise. */
export function headlessAgentForSession(session: string): string | null {
  if (!session.startsWith('agent-')) return null
  const name = session.slice('agent-'.length)
  return isHeadlessAgent(name) ? name : null
}

// ---- persistence --------------------------------------------------------------

function stateFile(storeDir: string): string { return join(storeDir, 'headless-agents.json') }
function logFile(storeDir: string, name: string): string { return join(storeDir, 'headless-agents', `${name.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`) }

function readPersisted(storeDir: string): PersistedFile {
  try {
    const raw = JSON.parse(readFileSync(stateFile(storeDir), 'utf-8')) as PersistedFile
    if (raw && raw.version === 1 && raw.agents && typeof raw.agents === 'object') return raw
  } catch { /* first run / unreadable -> empty */ }
  return { version: 1, agents: {} }
}

function persist(storeDir: string, e: Entry): void {
  try {
    mkdirSync(storeDir, { recursive: true })
    const file = readPersisted(storeDir)
    file.agents[e.name] = {
      runtime: e.spec.runtime, provider: e.spec.provider, model: e.spec.model,
      resumeToken: e.resumeToken, startedAt: e.startedAt, profile: e.profile, routed: e.routed,
    }
    atomicWriteFileSync(stateFile(storeDir), JSON.stringify(file, null, 2) + '\n')
  } catch (err) {
    logger.warn({ err, agent: e.name }, 'headless-agents: could not persist session state')
  }
}

function forgetPersisted(storeDir: string, name: string): void {
  try {
    const file = readPersisted(storeDir)
    if (!(name in file.agents)) return
    delete file.agents[name]
    atomicWriteFileSync(stateFile(storeDir), JSON.stringify(file, null, 2) + '\n')
  } catch { /* best effort */ }
}

function appendLog(storeDir: string, name: string, entry: HeadlessTurnLogEntry): void {
  try {
    mkdirSync(join(storeDir, 'headless-agents'), { recursive: true })
    appendFileSync(logFile(storeDir, name), JSON.stringify(entry) + '\n', 'utf-8')
  } catch (err) {
    logger.debug({ err, agent: name }, 'headless-agents: turn log append failed')
  }
}

export function readHeadlessTurnLog(name: string, limit = 50, storeDir: string = deps?.storeDir() ?? STORE_DIR): HeadlessTurnLogEntry[] {
  try {
    const p = logFile(storeDir, name)
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, limit)).map((l) => {
      try { return JSON.parse(l) as HeadlessTurnLogEntry } catch { return null }
    }).filter((x): x is HeadlessTurnLogEntry => x !== null)
  } catch {
    return []
  }
}

// ---- routed target resolution -----------------------------------------------

const ROUTED_INITIAL_PROFILE: ModelProfileId = 'routine_lowcost'

/** A routed agent never runs a pane: claude-tmux targets become claude-headless. */
export function headlessRuntimeFor(runtime: RuntimeKind): RuntimeKind {
  return runtime === 'claude-tmux' ? 'claude-headless' : runtime
}

function initialRoutedTarget(): ({ ok: true } & RoutedTarget) | { ok: false; error: string } {
  const mapState = readModelProfileMap()
  if (!mapState) return { ok: false, error: 'Jev-routed agent needs store/model-profile-map.json (no profile map on this install)' }
  if (!mapState.ok) return { ok: false, error: `Jev-routed agent: profile map unusable: ${mapState.error}` }
  const t = resolveProfileTarget(ROUTED_INITIAL_PROFILE, mapState, resolveModelId)
  if (!t) return { ok: false, error: `Jev-routed agent: profile map has no ${ROUTED_INITIAL_PROFILE} target` }
  const provider = t.provider ?? inferProvider(t.model)
  const runtime = headlessRuntimeFor(t.runtime ?? defaultRuntimeFor(provider, defaultAuthModeFor(provider), 'sub'))
  return { ok: true, runtime, provider, model: t.model }
}

// ---- lifecycle ----------------------------------------------------------------

export function headlessRunning(name: string): boolean { return entries.has(name) }

export function headlessRunningSince(name: string): number | null { return entries.get(name)?.startedAt ?? null }

export function headlessState(name: string): HeadlessState | null { return entries.get(name)?.state ?? null }

/** PaneState-shaped view for the message router's stuck bookkeeping. */
export function headlessPaneState(name: string): PaneState | null {
  const e = entries.get(name)
  if (!e) return null
  return e.state === 'busy' ? 'busy' : 'idle'
}

export interface HeadlessInfo {
  runtime: RuntimeKind
  provider: ProviderKind
  model: string
  state: HeadlessState
  routed: boolean
  profile: ModelProfileId | null
  startedAt: number
  lastTurnAt: number | null
  lastError: string | null
  turns: number
  queued: number
  hooks: 'native' | 'policy-engine' | 'none'
}

export function headlessInfo(name: string): HeadlessInfo | null {
  const e = entries.get(name)
  if (!e) return null
  let hooks: HeadlessInfo['hooks'] = 'none'
  try { hooks = e.runtime.capabilities(e.spec).supportsHooks } catch { /* keep none */ }
  return {
    runtime: e.spec.runtime, provider: e.spec.provider, model: e.spec.model, state: e.state, routed: e.routed,
    profile: e.profile, startedAt: e.startedAt, lastTurnAt: e.lastTurnAt, lastError: e.lastError, turns: e.turns,
    queued: e.queued, hooks,
  }
}

/** Activity-panel view: coarse label + the last few output lines. */
export function headlessActivity(name: string): { state: string; tail: string[] } {
  const e = entries.get(name)
  if (!e) return { state: 'stopped', tail: [] }
  const label = e.state === 'busy' ? 'working' : e.state === 'idle' ? 'idle' : e.state
  const last = readHeadlessTurnLog(name, 6).filter((l) => l.dir === 'out' || l.dir === 'error' || l.dir === 'switch')
  const tail = last.flatMap((l) => `[${l.runtime}/${l.model}] ${l.text}`.split('\n')).map((s) => s.trimEnd()).filter(Boolean).slice(-8)
  return { state: label, tail }
}

export async function startHeadlessAgent(name: string, opts: { fresh?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const d = await getDeps()
  if (entries.has(name)) return { ok: false, error: 'Agent is already running' }
  let spec: AgentSpec
  try { spec = d.buildSpec(name) } catch (err) { return { ok: false, error: `agent spec: ${(err as Error).message}` } }
  const routed = d.readRouting(name) === 'jev'
  let profile: ModelProfileId | null = null
  if (routed) {
    const t = d.initialRoutedTarget()
    if (!t.ok) return { ok: false, error: t.error }
    spec = { ...spec, runtime: headlessRuntimeFor(t.runtime), provider: t.provider, model: t.model }
    profile = ROUTED_INITIAL_PROFILE
  } else {
    spec = { ...spec, runtime: headlessRuntimeFor(spec.runtime) }
  }
  let runtime: AgentRuntime
  try {
    runtime = await getRuntime(spec.runtime)
  } catch (err) {
    const msg = err instanceof RuntimeNotAvailableError ? err.message : `runtime ${spec.runtime}: ${(err as Error).message}`
    return { ok: false, error: msg }
  }
  const storeDir = d.storeDir()
  const persisted = readPersisted(storeDir).agents[name]
  // A resume token is only meaningful on the runtime that issued it.
  const resumeToken = !opts.fresh && persisted && persisted.runtime === spec.runtime && persisted.model === spec.model
    ? persisted.resumeToken
    : null
  const e: Entry = {
    name, spec, runtime, routed, profile,
    startedAt: Math.floor(d.now() / 1000),
    resumeToken, chain: Promise.resolve(), inFlight: 0, queued: 0, state: 'idle',
    lastResult: null, lastTurnAt: null, lastError: null, turns: 0, alertedFor: null,
  }
  entries.set(name, e)
  persist(storeDir, e)
  logger.info({ agent: name, runtime: spec.runtime, model: spec.model, routed, resume: !!resumeToken, fresh: !!opts.fresh }, 'headless-agents: session started')
  return { ok: true }
}

export async function stopHeadlessAgent(name: string): Promise<{ ok: boolean; error?: string }> {
  const e = entries.get(name)
  if (!e) return { ok: false, error: 'Agent is not running' }
  entries.delete(name)
  // The resume token stays on disk: a later non-fresh start continues the
  // conversation, a fresh start (or a runtime change) drops it. An in-flight
  // turn finishes on its own, bounded by the adapter's timeout; its result is
  // ignored because the entry is gone.
  logger.info({ agent: name, runtime: e.spec.runtime, inFlight: e.inFlight }, 'headless-agents: session stopped')
  return { ok: true }
}

/** Drop the persisted resume token (a `fresh` start does this implicitly). */
export function forgetHeadlessSession(name: string): void {
  forgetPersisted(deps?.storeDir() ?? STORE_DIR, name)
}

// ---- delivery -----------------------------------------------------------------

const AUTH_RX = /auth|sign in|login|not logged in|401|exit=3/i
const BLOCKED_RX = /429|rate.?limit|quota|usage limit|insufficient|RESOURCE_EXHAUSTED|overloaded/i

function classify(r: RunResult): HeadlessState {
  if (!r.blocked) return 'idle'
  const reason = r.reason ?? ''
  if (AUTH_RX.test(reason)) return 'auth'
  if (BLOCKED_RX.test(reason)) return 'blocked'
  return 'idle'
}

export async function sendToHeadlessAgent(
  name: string,
  text: string,
  opts: { onBusyTimeout?: 'send' | 'abort' } = {},
): Promise<'sent' | 'aborted-busy'> {
  const e = entries.get(name)
  if (!e) throw new Error(`headless agent ${name} is not running`)
  if (opts.onBusyTimeout === 'abort' && (e.inFlight > 0 || e.queued > 0)) return 'aborted-busy'
  const d = await getDeps()
  e.queued++
  e.chain = e.chain
    .then(() => runTurn(d, e, text))
    .catch((err) => { logger.error({ err, agent: name }, 'headless-agents: turn crashed') })
  return 'sent'
}

async function maybeReroute(d: Deps, e: Entry, text: string): Promise<void> {
  if (!e.routed || !d.routingAll()) return
  const taskRef = `session:${e.name}:${d.now()}`
  const override = await d.routeForTurn({
    agent: e.name, text, taskRef,
    current: { runtime: e.spec.runtime, provider: e.spec.provider, model: e.spec.model },
    currentProfile: e.profile,
  })
  if (!override) return
  const runtimeKind = headlessRuntimeFor(override.runtime)
  if (runtimeKind === e.spec.runtime && override.model === e.spec.model) {
    e.profile = override.profile as ModelProfileId
    return
  }
  let runtime: AgentRuntime
  try { runtime = await getRuntime(runtimeKind) } catch (err) {
    logger.warn({ err, agent: e.name, runtime: runtimeKind }, 'headless-agents: routed target runtime unavailable, staying')
    return
  }
  const from = `${e.spec.runtime}/${e.spec.model}`
  e.spec = { ...e.spec, runtime: runtimeKind, provider: override.provider, model: override.model }
  e.runtime = runtime
  e.resumeToken = null
  e.profile = override.profile as ModelProfileId
  appendLog(d.storeDir(), e.name, {
    ts: d.now(), dir: 'switch', runtime: e.spec.runtime, model: e.spec.model, profile: e.profile,
    text: `Jev: ${from} -> ${e.spec.runtime}/${e.spec.model} (${e.profile}); new session`,
  })
  persist(d.storeDir(), e)
  logger.info({ agent: e.name, from, to: `${e.spec.runtime}/${e.spec.model}`, profile: e.profile }, 'headless-agents: Jev switched the target for the next turn')
}

async function runTurn(d: Deps, e: Entry, text: string): Promise<void> {
  e.queued--
  if (!entries.has(e.name) || entries.get(e.name) !== e) return // stopped while queued
  const storeDir = d.storeDir()
  try {
    await maybeReroute(d, e, text)
  } catch (err) {
    logger.warn({ err, agent: e.name }, 'headless-agents: routing failed, running on the current target')
  }
  e.inFlight++
  e.state = 'busy'
  appendLog(storeDir, e.name, { ts: d.now(), dir: 'in', runtime: e.spec.runtime, model: e.spec.model, profile: e.profile, text: text.slice(0, 4000) })
  try {
    const r = await e.runtime.run(e.spec, text, { resume: e.resumeToken ?? undefined, allowTools: true, timeoutAsError: true })
    if (!entries.has(e.name) || entries.get(e.name) !== e) return
    e.lastResult = r
    e.lastTurnAt = d.now()
    e.turns++
    if (r.sessionRef) e.resumeToken = r.sessionRef
    e.state = classify(r)
    e.lastError = r.blocked ? (r.reason ?? 'blocked') : null
    appendLog(storeDir, e.name, {
      ts: d.now(), dir: r.blocked ? 'error' : 'out', runtime: e.spec.runtime, model: e.spec.model, profile: e.profile,
      text: (r.text ?? (r.reason ?? '')).slice(0, 4000), blocked: r.blocked, reason: r.reason,
    })
    if (e.state !== 'idle' && e.alertedFor !== e.state) {
      e.alertedFor = e.state
      d.notifyMain(
        `[runtime] ${e.name} (${e.spec.runtime}/${e.spec.model}) ${e.state === 'auth' ? 'nincs bejelentkezve / hitelesítési hiba' : 'kvóta- vagy limit-hiba'}: ${(r.reason ?? '').slice(0, 300)}. ` +
        `A feladat nem futott le; ellenőrizd a runtime loginját vagy a kulcsát, majd indítsd újra az agentet.`,
      )
    } else if (e.state === 'idle') {
      e.alertedFor = null
    }
    persist(storeDir, e)
  } catch (err) {
    e.state = 'idle'
    e.lastError = (err as Error).message
    appendLog(storeDir, e.name, { ts: d.now(), dir: 'error', runtime: e.spec.runtime, model: e.spec.model, profile: e.profile, text: `run threw: ${(err as Error).message}` })
    logger.error({ err, agent: e.name }, 'headless-agents: run threw')
  } finally {
    e.inFlight--
    if (e.state === 'busy') e.state = 'idle'
  }
}

/** Every running headless agent, for status surfaces. */
export function listHeadlessAgents(): string[] { return [...entries.keys()] }
