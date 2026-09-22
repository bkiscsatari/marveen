// Which subscription-CLI runtimes the model picker may offer for a sub-agent.
//
// The dashboard's model dropdown must not list a target that will 401 on its
// first task (the same rule the vault-gated DeepSeek/MiniMax API groups follow
// in routes/agents.ts). For a subscription CLI "usable" means two cheap facts:
// the binary resolves on PATH, and the CLI's own credential store exists. A
// real health probe (an actual one-step run) is too slow for a 3-second poll,
// so this is deliberately a presence check; the first task reports auth
// failures through the headless session loop (state 'auth' on the card).
//
// Cached for 60 s: the dropdown is rebuilt on every agent open, and `command
// -v` per CLI per open is wasteful.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AuthMode, ProviderKind, RuntimeKind } from '../runtime/types.js'

export interface SubscriptionModelEntry {
  /** Model id the PUT writes (MODEL_ID_RE-valid). */
  id: string
  label: string
  runtime: RuntimeKind
  provider: ProviderKind
  /** Legacy dashboard auth value the PUT writes ('shared' = subscription). */
  authMode: 'shared' | 'api'
  /** Runtime-level auth mode, for display. */
  runtimeAuth: AuthMode
}

export interface SubscriptionRuntimeAvailability {
  checkedAt: number
  minimax: { installed: boolean; loggedIn: boolean }
  codex: { installed: boolean; loggedIn: boolean }
  gemini: { installed: boolean; loggedIn: boolean }
  entries: SubscriptionModelEntry[]
}

const CACHE_MS = 60_000
let cached: SubscriptionRuntimeAvailability | null = null

function binaryOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf-8', timeout: 3000, env, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().length > 0
  } catch {
    return false
  }
}

/** Pure part: build the entry list from the three presence facts. */
export function subscriptionEntriesFor(facts: {
  minimax: { installed: boolean; loggedIn: boolean }
  codex: { installed: boolean; loggedIn: boolean }
  gemini: { installed: boolean; loggedIn: boolean }
}): SubscriptionModelEntry[] {
  const out: SubscriptionModelEntry[] = []
  if (facts.minimax.installed && facts.minimax.loggedIn) {
    out.push({ id: 'minimax-m3', label: 'MiniMax M3 (előfizetés, MiniMax Code)', runtime: 'minimax-cli', provider: 'minimax', authMode: 'shared', runtimeAuth: 'subscription' })
    out.push({ id: 'minimax-m2.7-highspeed', label: 'MiniMax M2.7 highspeed (előfizetés, MiniMax Code)', runtime: 'minimax-cli', provider: 'minimax', authMode: 'shared', runtimeAuth: 'subscription' })
  }
  // Codex / Gemini ids follow docs/runtime.md and src/runtime/model-catalog.ts;
  // the CLI validates the name on the first turn, and a wrong one surfaces as
  // an 'error' row in the agent's session log rather than a silent fallback.
  if (facts.codex.installed && facts.codex.loggedIn) {
    out.push({ id: 'gpt-5.6-sol', label: 'GPT-5.6 sol (ChatGPT-előfizetés, Codex CLI)', runtime: 'codex-cli', provider: 'openai', authMode: 'shared', runtimeAuth: 'subscription' })
  }
  if (facts.gemini.installed && facts.gemini.loggedIn) {
    out.push({ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google-előfizetés, Gemini CLI)', runtime: 'gemini-cli', provider: 'google', authMode: 'shared', runtimeAuth: 'subscription' })
    out.push({ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google-előfizetés, Gemini CLI)', runtime: 'gemini-cli', provider: 'google', authMode: 'shared', runtimeAuth: 'subscription' })
  }
  return out
}

export function subscriptionRuntimeAvailability(opts: { now?: number; force?: boolean; home?: string; env?: NodeJS.ProcessEnv } = {}): SubscriptionRuntimeAvailability {
  const now = opts.now ?? Date.now()
  if (!opts.force && cached && now - cached.checkedAt < CACHE_MS) return cached
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const minimaxDir = env.MINIMAX_DATA_DIR || join(home, '.minimax')
  const codexHome = env.CODEX_HOME || join(home, '.codex')
  const facts = {
    minimax: { installed: binaryOnPath('mcode', env), loggedIn: existsSync(join(minimaxDir, 'auth')) || existsSync(join(minimaxDir, 'local-runtime.auth.json')) },
    codex: { installed: binaryOnPath('codex', env), loggedIn: existsSync(join(codexHome, 'auth.json')) },
    gemini: { installed: binaryOnPath('gemini', env), loggedIn: existsSync(join(home, '.gemini', 'oauth_creds.json')) },
  }
  cached = { checkedAt: now, ...facts, entries: subscriptionEntriesFor(facts) }
  return cached
}

/** Test hook. */
export function _resetRuntimeAvailabilityCache(): void { cached = null }
