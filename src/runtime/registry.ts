// Runtime registry (Phase 0).
//
// Adapters register themselves here; consumers ask for one by kind. Built-in
// adapters load LAZILY on first request so importing the registry (pure) never
// drags the tmux launcher (heavy, I/O at import time) into a module that only
// needed the types -- and so an adapter that is not shipped yet fails with a
// message that names the phase instead of a bare "undefined".

import { isRuntimeKind, RUNTIME_KINDS, type AgentRuntime, type RuntimeKind } from './types.js'

export class RuntimeNotAvailableError extends Error {
  constructor(public readonly kind: string, detail: string) {
    super(`Agent runtime "${kind}" is not available: ${detail}`)
    this.name = 'RuntimeNotAvailableError'
  }
}

const registered = new Map<RuntimeKind, AgentRuntime>()

// Which phase of the agent-agnostic plan ships each adapter. Used only for
// the error text, so an operator who selects an unshipped runtime learns
// what is missing rather than seeing a module-not-found stack.
const SHIP_PHASE: Record<RuntimeKind, string> = {
  'claude-tmux': 'Phase 0',
  'claude-headless': 'Phase 1',
  'codex-cli': 'Phase 2',
  'gemini-cli': 'Phase 3',
  'native-api': 'Phase 4',
}

type Loader = () => Promise<{ default: AgentRuntime } | { runtime: AgentRuntime }>

const BUILTIN_LOADERS: Partial<Record<RuntimeKind, Loader>> = {
  'claude-tmux': () => import('./claude-tmux.js'),
  'claude-headless': () => import('./claude-headless.js'),
  'codex-cli': () => import('./codex-cli.js'),
  'gemini-cli': () => import('./gemini-cli.js'),
}

export function registerRuntime(rt: AgentRuntime): void {
  registered.set(rt.kind, rt)
}

/** Test hook: forget every registered adapter. */
export function resetRuntimeRegistry(): void {
  registered.clear()
}

export function listRegisteredRuntimes(): RuntimeKind[] {
  return [...registered.keys()]
}

export function isRuntimeRegistered(kind: RuntimeKind): boolean {
  return registered.has(kind)
}

/** Kinds this build can provide (registered now, or loadable on demand). */
export function availableRuntimeKinds(): RuntimeKind[] {
  return RUNTIME_KINDS.filter((k) => registered.has(k) || BUILTIN_LOADERS[k] !== undefined)
}

export async function getRuntime(kind: RuntimeKind): Promise<AgentRuntime> {
  const hit = registered.get(kind)
  if (hit) return hit
  const load = BUILTIN_LOADERS[kind]
  if (!load) {
    throw new RuntimeNotAvailableError(kind, `adapter ships in ${SHIP_PHASE[kind] ?? 'a later phase'} of the agent-agnostic plan`)
  }
  const mod = await load()
  const rt = 'default' in mod ? mod.default : mod.runtime
  if (!rt || rt.kind !== kind) {
    throw new RuntimeNotAvailableError(kind, 'adapter module did not export a matching runtime')
  }
  registered.set(kind, rt)
  return rt
}

/**
 * Fleet-wide default runtime: MARVEEN_DEFAULT_RUNTIME when it names a known
 * kind, else claude-tmux (the pre-Phase-0 behaviour). An unknown value is
 * ignored, not honoured, so a typo cannot move the fleet.
 */
export function defaultRuntimeKind(env: NodeJS.ProcessEnv = process.env): RuntimeKind {
  const raw = env.MARVEEN_DEFAULT_RUNTIME?.trim()
  return raw && isRuntimeKind(raw) ? raw : 'claude-tmux'
}
