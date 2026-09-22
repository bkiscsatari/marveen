// Anthropic-compatible endpoint routing for the CLAUDE CODE CLI.
//
// Several vendors expose an Anthropic-protocol `/v1/messages` endpoint, so the
// Claude Code CLI can be pointed at them with ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN. This is how the fleet ran DeepSeek / MiniMax /
// OpenRouter / Ollama models before the agent-agnostic runtimes existed, and it
// stays the mechanism for every `claude-*` runtime. Moved here from
// web/agent-process.ts (Phase 0) so the claude-tmux and claude-headless
// adapters share ONE table; agent-process.ts re-exports the old names.
//
// Verified endpoints (2026-09-21, official docs):
//   DeepSeek   https://api.deepseek.com/anthropic
//   MiniMax    https://api.minimax.io/anthropic
//   Moonshot   https://api.moonshot.ai/anthropic     (kimi-* models)
//   Zhipu      https://api.z.ai/api/anthropic         (glm-* models)
//   OpenRouter https://openrouter.ai/api              (SDK appends /v1/messages)
//   Ollama     $OLLAMA_URL (/v1/messages)             (token literally "ollama")
// NOT available: OpenAI and Google Gemini -- those need their own CLI or the
// native-api runtime; never route them through here.
//
// hu: A modell-azonosító alapján eldönti, melyik providerhez tartozik, és
// felépíti a shell export-láncot, ami a Claude Code CLI-t az adott provider
// Anthropic-kompatibilis végpontjára téríti. Tiszta függvény (nincs I/O) -- a
// titkot a hívó adja át `secretLookup`-on keresztül, hogy vault nélkül
// tesztelhető legyen.

import { OLLAMA_URL } from '../config.js'
import { shSingleQuote } from './shell-quote.js'
import { inferProvider } from './resolve-spec.js'
import { providerSecretIds } from './secret-ids.js'
import type { ProviderKind } from './types.js'

/** Legacy discriminator kept for the existing call sites/tests. */
export type AnthropicCompatProvider =
  | 'claude'
  | 'deepseek'
  | 'minimax'
  | 'openrouter'
  | 'ollama'
  | 'moonshot'
  | 'zhipu'
  /** openai / google: no Anthropic-compatible endpoint exists. */
  | 'unsupported'

const ENDPOINTS: Partial<Record<ProviderKind, string>> = {
  deepseek: 'https://api.deepseek.com/anthropic',
  minimax: 'https://api.minimax.io/anthropic',
  moonshot: 'https://api.moonshot.ai/anthropic',
  zhipu: 'https://api.z.ai/api/anthropic',
  openrouter: 'https://openrouter.ai/api',
}

/** Providers the Claude CLI can be pointed at. OpenAI/Google are NOT here. */
export const ANTHROPIC_COMPAT_PROVIDERS: readonly ProviderKind[] = [
  'anthropic', 'deepseek', 'minimax', 'moonshot', 'zhipu', 'openrouter', 'ollama',
]

export function isAnthropicCompatProvider(p: ProviderKind): boolean {
  return ANTHROPIC_COMPAT_PROVIDERS.includes(p)
}

// First secret id that resolves, in alias order (legacy ids first so an
// existing vault keeps working and the historical tests keep passing).
function firstSecret(ids: readonly string[], lookup: (id: string) => string | null): string {
  for (const id of ids) {
    const v = lookup(id)
    if (v) return v
  }
  return ''
}

/**
 * Structured form: the environment variables (no shell quoting) a Claude CLI
 * child process needs to talk to the model's vendor. Empty for Anthropic
 * itself and for vendors without a compatible endpoint. Used by the
 * claude-headless adapter (spawn env); the tmux launcher uses the string form.
 */
export function resolveProviderEnvVars(
  model: string,
  secretLookup: (id: string) => string | null,
): Record<string, string> {
  const provider = inferProvider(model)
  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'google':
      return {}
    case 'ollama':
      return { ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_BASE_URL: OLLAMA_URL, ANTHROPIC_MODEL: model }
    case 'minimax':
      return {
        ANTHROPIC_AUTH_TOKEN: firstSecret(providerSecretIds('minimax'), secretLookup),
        ANTHROPIC_BASE_URL: ENDPOINTS.minimax!,
        ANTHROPIC_MODEL: model,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      }
    default:
      return {
        ANTHROPIC_AUTH_TOKEN: firstSecret(providerSecretIds(provider), secretLookup),
        ANTHROPIC_BASE_URL: ENDPOINTS[provider]!,
        ANTHROPIC_MODEL: model,
      }
  }
}

export function resolveProviderEnv(
  model: string,
  secretLookup: (id: string) => string | null,
): { provider: AnthropicCompatProvider; exportsStr: string } {
  const provider = inferProvider(model)
  const modelQ = shSingleQuote(model)

  switch (provider) {
    case 'anthropic':
      return { provider: 'claude', exportsStr: '' }
    case 'deepseek': {
      const key = firstSecret(providerSecretIds('deepseek'), secretLookup)
      return {
        provider: 'deepseek',
        exportsStr: `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=${ENDPOINTS.deepseek} && export ANTHROPIC_MODEL=${modelQ} && `,
      }
    }
    case 'minimax': {
      const key = firstSecret(providerSecretIds('minimax'), secretLookup)
      // MiniMax's own /anthropic compat layer misreports a 200K context window in
      // its model metadata instead of M3's real 1M (MiniMax-AI/MiniMax-M2.7#46,
      // confirmed live 2026-08-19). Claude Code trusts that metadata and
      // auto-compacts at ~167k as a result. CLAUDE_CODE_MAX_CONTEXT_TOKENS is
      // the vendor-documented workaround. Paired with contextLimitForModel's
      // minimax- rule in context-guard.ts -- change both or neither.
      return {
        provider: 'minimax',
        exportsStr: `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=${ENDPOINTS.minimax} && export ANTHROPIC_MODEL=${modelQ} && export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 && `,
      }
    }
    case 'moonshot': {
      const key = firstSecret(providerSecretIds('moonshot'), secretLookup)
      return {
        provider: 'moonshot',
        exportsStr: `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=${ENDPOINTS.moonshot} && export ANTHROPIC_MODEL=${modelQ} && `,
      }
    }
    case 'zhipu': {
      const key = firstSecret(providerSecretIds('zhipu'), secretLookup)
      return {
        provider: 'zhipu',
        exportsStr: `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=${ENDPOINTS.zhipu} && export ANTHROPIC_MODEL=${modelQ} && `,
      }
    }
    case 'openrouter': {
      const key = firstSecret(providerSecretIds('openrouter'), secretLookup)
      return {
        provider: 'openrouter',
        exportsStr: `export ANTHROPIC_AUTH_TOKEN="${key}" && export ANTHROPIC_BASE_URL=${ENDPOINTS.openrouter} && export ANTHROPIC_MODEL=${modelQ} && `,
      }
    }
    case 'ollama':
      return {
        provider: 'ollama',
        exportsStr: `export ANTHROPIC_AUTH_TOKEN=ollama && export ANTHROPIC_BASE_URL=${OLLAMA_URL} && export ANTHROPIC_MODEL=${modelQ} && `,
      }
    case 'openai':
    case 'google':
      // No Anthropic-compatible endpoint exists for these vendors (verified
      // 2026-09-21: api.openai.com/v1/messages -> 404, Gemini offers only an
      // OpenAI-compatible surface). A claude-* runtime cannot run them; the
      // spec resolver warns about the mismatch. Return an empty chain so a
      // misconfigured launch fails loudly at the vendor ("model not found")
      // rather than silently hitting Anthropic with someone else's model id.
      return { provider: 'unsupported', exportsStr: '' }
  }
}
