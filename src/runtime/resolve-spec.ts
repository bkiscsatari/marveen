// Pure resolvers for the runtime / provider / authMode axes (Phase 0).
//
// ONE place decides which vendor a model id belongs to and which runtime should
// execute it. Before Phase 0 the same prefix heuristic lived in
// agent-process.ts (resolveProviderEnv), context-guard.ts (context windows)
// and agent-config.ts (aliases) -- three copies that could drift. No I/O here;
// the registry / agent-config layer feeds this from files and env.

import {
  isProviderKind,
  isRuntimeKind,
  type AgentRole,
  type AuthMode,
  type ProviderKind,
  type RuntimeKind,
} from './types.js'

/**
 * Vendor inferred from the model id. Order matters: explicit vendor prefixes
 * first, then the OpenRouter `vendor/model` shape, then everything else is an
 * Ollama tag (the historical fallback, kept so `qwen3.6:27b` keeps working).
 */
export function inferProvider(model: string): ProviderKind {
  const m = model.trim().toLowerCase()
  if (m.startsWith('claude-')) return 'anthropic'
  if (m.startsWith('deepseek-')) return 'deepseek'
  if (m.startsWith('minimax-')) return 'minimax'
  if (m.startsWith('kimi-') || m.startsWith('moonshot-')) return 'moonshot'
  if (m.startsWith('glm-')) return 'zhipu'
  if (m.startsWith('gemini-')) return 'google'
  if (m.startsWith('gpt-') || m.startsWith('codex') || /^o[1-9](-|$)/.test(m) || m.startsWith('chatgpt-')) return 'openai'
  // OpenRouter ids are `vendor/model` (contain '/'); Ollama tags use ':' and no '/'.
  if (m.includes('/')) return 'openrouter'
  return 'ollama'
}

/**
 * Accept both the new vocabulary and the legacy Claude-only agent-config
 * values: 'shared' and 'own_team' were subscription logins (host OAuth / a
 * named Claude plan), 'api' was an ANTHROPIC_API_KEY from the vault.
 */
export function normalizeAuthMode(raw: unknown): AuthMode | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if (v === 'api') return 'api'
  if (v === 'subscription' || v === 'shared' || v === 'own_team' || v === 'oauth') return 'subscription'
  return null
}

/** Providers each runtime can actually serve. */
export const RUNTIME_PROVIDERS: Record<RuntimeKind, readonly ProviderKind[]> = {
  // Claude Code CLI: Anthropic natively, plus every vendor with an
  // Anthropic-compatible /v1/messages endpoint (see anthropic-compat-env.ts).
  'claude-tmux': ['anthropic', 'deepseek', 'minimax', 'moonshot', 'zhipu', 'openrouter', 'ollama'],
  'claude-headless': ['anthropic', 'deepseek', 'minimax', 'moonshot', 'zhipu', 'openrouter', 'ollama'],
  'codex-cli': ['openai'],
  'gemini-cli': ['google'],
  'native-api': ['anthropic', 'openai', 'google', 'deepseek', 'minimax', 'moonshot', 'zhipu', 'openrouter', 'ollama'],
  // MiniMax Code (`mcode`): the vendor's own agent CLI, subscription login or API key.
  'minimax-cli': ['minimax'],
}

export function runtimeSupportsProvider(runtime: RuntimeKind, provider: ProviderKind): boolean {
  return RUNTIME_PROVIDERS[runtime].includes(provider)
}

/**
 * Default runtime when the agent config names none.
 *
 * Phase 0 is BEHAVIOUR-NEUTRAL: every provider the Claude CLI could already
 * reach keeps running on claude-tmux exactly as before, whatever the role.
 * Only vendors the Claude CLI cannot reach get a different default (their own
 * subscription CLI, or the native loop for API keys). Later phases flip the
 * worker/background defaults to claude-headless behind feature flags.
 */
export function defaultRuntimeFor(provider: ProviderKind, authMode: AuthMode, _role: AgentRole): RuntimeKind {
  switch (provider) {
    case 'openai':
      return authMode === 'subscription' ? 'codex-cli' : 'native-api'
    case 'google':
      return authMode === 'subscription' ? 'gemini-cli' : 'native-api'
    case 'minimax':
      // api (the historical default for MiniMax) keeps the Claude-CLI Anthropic-compat
      // path; a SUBSCRIPTION (mcode login, no API key) needs the vendor's own CLI.
      return authMode === 'subscription' ? 'minimax-cli' : 'claude-tmux'
    default:
      return 'claude-tmux'
  }
}

/** Default auth mode: Anthropic/OpenAI/Google are subscription-first on this
 *  fleet; every other vendor only sells API keys. */
export function defaultAuthModeFor(provider: ProviderKind): AuthMode {
  return provider === 'anthropic' || provider === 'openai' || provider === 'google' ? 'subscription' : 'api'
}

export interface RawRuntimeConfig {
  runtime?: unknown
  provider?: unknown
  authMode?: unknown
}

export interface ResolvedRuntimeSpec {
  runtime: RuntimeKind
  provider: ProviderKind
  authMode: AuthMode
  source: {
    runtime: 'config' | 'env' | 'default'
    provider: 'config' | 'inferred'
    authMode: 'config' | 'default'
  }
  /** Misconfigurations worth surfacing; resolution itself never throws. */
  warnings: string[]
}

export interface ResolveRuntimeSpecOptions {
  role: AgentRole
  /** MARVEEN_DEFAULT_RUNTIME from the environment (validated here). */
  envDefaultRuntime?: string | undefined
}

/**
 * Precedence: explicit config > env default > inferred default. A config value
 * that is not a known runtime/provider is IGNORED WITH A WARNING rather than
 * silently changing what runs -- the same "no silent model change" rule the
 * model-profile layer follows.
 */
export function resolveRuntimeSpec(
  model: string,
  cfg: RawRuntimeConfig,
  opts: ResolveRuntimeSpecOptions,
): ResolvedRuntimeSpec {
  const warnings: string[] = []

  const inferred = inferProvider(model)
  let provider: ProviderKind = inferred
  let providerSource: ResolvedRuntimeSpec['source']['provider'] = 'inferred'
  if (cfg.provider !== undefined && cfg.provider !== null && cfg.provider !== '') {
    if (isProviderKind(cfg.provider)) {
      provider = cfg.provider
      providerSource = 'config'
      if (provider !== inferred) {
        warnings.push(`provider_mismatch: config says ${provider}, model id "${model}" looks like ${inferred}`)
      }
    } else {
      warnings.push(`unknown_provider:${String(cfg.provider).slice(0, 40)}`)
    }
  }

  let authMode = defaultAuthModeFor(provider)
  let authSource: ResolvedRuntimeSpec['source']['authMode'] = 'default'
  if (cfg.authMode !== undefined && cfg.authMode !== null && cfg.authMode !== '') {
    const norm = normalizeAuthMode(cfg.authMode)
    if (norm) {
      authMode = norm
      authSource = 'config'
    } else {
      warnings.push(`unknown_auth_mode:${String(cfg.authMode).slice(0, 40)}`)
    }
  }

  let runtime: RuntimeKind | null = null
  let runtimeSource: ResolvedRuntimeSpec['source']['runtime'] = 'default'
  if (cfg.runtime !== undefined && cfg.runtime !== null && cfg.runtime !== '') {
    if (isRuntimeKind(cfg.runtime)) {
      runtime = cfg.runtime
      runtimeSource = 'config'
    } else {
      warnings.push(`unknown_runtime:${String(cfg.runtime).slice(0, 40)}`)
    }
  }
  if (!runtime && opts.envDefaultRuntime) {
    if (isRuntimeKind(opts.envDefaultRuntime)) {
      runtime = opts.envDefaultRuntime
      runtimeSource = 'env'
    } else {
      warnings.push(`unknown_env_default_runtime:${opts.envDefaultRuntime.slice(0, 40)}`)
    }
  }
  if (!runtime) {
    runtime = defaultRuntimeFor(provider, authMode, opts.role)
    runtimeSource = 'default'
  }

  if (!runtimeSupportsProvider(runtime, provider)) {
    warnings.push(`runtime_provider_mismatch: ${runtime} cannot serve ${provider} models`)
  }

  return {
    runtime,
    provider,
    authMode,
    source: { runtime: runtimeSource, provider: providerSource, authMode: authSource },
    warnings,
  }
}
