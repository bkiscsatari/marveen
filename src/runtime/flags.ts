// Feature flags for the phased runtime migration (Phase 1). Pure: env in,
// decision out, so every gate is unit-testable and the defaults are visibly
// behaviour-neutral (the pre-migration path wins whenever a flag is unset or
// names something unknown).

import { isRuntimeKind, type RuntimeKind } from './types.js'

/** MARVEEN_WORKER_RUNTIME: which runtime serves runAgent() one-shots. */
export function workerRuntimeKind(env: NodeJS.ProcessEnv = process.env): 'claude-tmux' | 'claude-headless' {
  return (env.MARVEEN_WORKER_RUNTIME || '').trim().toLowerCase() === 'claude-headless' ? 'claude-headless' : 'claude-tmux'
}

export type BgRuntimeKind = 'legacy-tmux' | RuntimeKind

/** MARVEEN_BG_RUNTIME: which runtime executes dashboard background tasks. */
export function bgRuntimeKind(env: NodeJS.ProcessEnv = process.env): BgRuntimeKind {
  const raw = (env.MARVEEN_BG_RUNTIME || '').trim()
  return isRuntimeKind(raw) ? raw : 'legacy-tmux'
}
