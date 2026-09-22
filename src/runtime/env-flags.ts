// Where the runtime feature flags are read from.
//
// The dashboard runs under systemd with only PATH/HOME/TZ in its environment;
// the install's .env is read by config.ts through readEnvFile(), never loaded
// into process.env. The first cut of the runtime flags read process.env only,
// so the documented way to set them (.env, see .env.example) had NO effect in
// production -- they worked only in a dev shell that exported them. MODEL_ROUTING
// already did the right thing (web/model-routing.ts); this generalises it.
//
// Precedence: a non-empty process.env value (tests, a dev shell) > the .env
// file. Cached briefly because some callers (isHeadlessAgent via the runtime
// spec) run in per-agent watcher loops.

import { readEnvFile } from '../env.js'

export const RUNTIME_FLAG_KEYS = [
  'MARVEEN_DEFAULT_RUNTIME',
  'MARVEEN_WORKER_RUNTIME',
  'MARVEEN_BG_RUNTIME',
  'MARVEEN_AGENT_BACKEND',
  'CHANNEL_BRIDGE',
] as const

const CACHE_MS = 5_000
let cached: { file: Record<string, string>; at: number } | null = null

function fileFlags(now: number, readFile?: () => Record<string, string>): Record<string, string> {
  if (!readFile && cached && now - cached.at < CACHE_MS) return cached.file
  let file: Record<string, string> = {}
  try { file = (readFile ?? (() => readEnvFile([...RUNTIME_FLAG_KEYS])))() } catch { file = {} }
  if (!readFile) cached = { file, at: now }
  return file
}

/** process.env with the runtime flags filled in from .env where process.env has none. */
export function flagEnv(opts: { now?: number; readFile?: () => Record<string, string>; base?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  const fromFile = fileFlags(opts.now ?? Date.now(), opts.readFile)
  const env: NodeJS.ProcessEnv = { ...(opts.base ?? process.env) }
  for (const k of RUNTIME_FLAG_KEYS) {
    if (!(env[k] ?? '').trim() && (fromFile[k] ?? '').trim()) env[k] = fromFile[k]
  }
  return env
}

/** Test hook. */
export function resetFlagEnvCache(): void {
  cached = null
}
