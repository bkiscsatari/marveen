// Feature flags for the phased runtime migration (Phase 1). Pure: env in,
// decision out, so every gate is unit-testable and the defaults are visibly
// behaviour-neutral (the pre-migration path wins whenever a flag is unset or
// names something unknown).
//
// The default `env` is flagEnv(): process.env with the install's .env filled
// in, because the dashboard's systemd unit does not load .env (see env-flags.ts).

import { isRuntimeKind, type RuntimeKind } from './types.js'
import { flagEnv } from './env-flags.js'

/** Trimmed, lowercased flag value ('' when unset). */
export function flagValue(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] || '').trim().toLowerCase()
}

/** MARVEEN_WORKER_RUNTIME: which runtime serves runAgent() one-shots. */
export function workerRuntimeKind(env: NodeJS.ProcessEnv = flagEnv()): 'claude-tmux' | 'claude-headless' {
  return flagValue(env, 'MARVEEN_WORKER_RUNTIME') === 'claude-headless' ? 'claude-headless' : 'claude-tmux'
}

export type BgRuntimeKind = 'legacy-tmux' | RuntimeKind

/** MARVEEN_BG_RUNTIME: which runtime executes dashboard background tasks. */
export function bgRuntimeKind(env: NodeJS.ProcessEnv = flagEnv()): BgRuntimeKind {
  const raw = flagValue(env, 'MARVEEN_BG_RUNTIME')
  return isRuntimeKind(raw) ? raw : 'legacy-tmux'
}

/** MARVEEN_AGENT_BACKEND: 'sdk' or the default tmux 'worker'. */
export function agentBackend(env: NodeJS.ProcessEnv = flagEnv()): 'worker' | 'sdk' {
  return flagValue(env, 'MARVEEN_AGENT_BACKEND') === 'sdk' ? 'sdk' : 'worker'
}

/** MARVEEN_DEFAULT_RUNTIME, raw (validated by resolveRuntimeSpec). */
export function envDefaultRuntime(env: NodeJS.ProcessEnv = flagEnv()): string | undefined {
  return flagValue(env, 'MARVEEN_DEFAULT_RUNTIME') || undefined
}
