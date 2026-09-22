// Behaviour-neutral model profiles (card c755f4b2, Phase 1 Block B) --
// extended in the agent-agnostic Phase 4b so a profile can name a RUNTIME
// as well as a model.
//
// The point of this layer is ABSTRACTION, not re-tiering. An agent config can
// name a generic capability tier instead of a concrete vendor model id, and the
// concrete mapping lives in a deployment-local file. Phase 1 ships a map whose
// answers are byte-identical to the models the fleet already runs, so turning
// this on changes nothing observable.
//
// Map values are either a plain model id (legacy, still fully supported) or an
// object { model, runtime?, provider? } -- the (runtime, provider, model)
// triple the Jev router and the fallback runner need once several runtimes
// exist. `profiles` keeps exposing the model id per profile for every
// existing consumer; `targets` carries the full triple.
//
// Deliberately NOT the same concept as templates/profiles/*.json: that
// `profile` field is a Claude Code PERMISSIONS template (filesystem allow/deny,
// permissionMode) and has nothing to do with model selection. Overloading it
// would couple two unrelated axes, so `modelProfile` is a separate field with
// its own map (spec 5.1).
//
// Pure logic: no fs, no env, no I/O. The runner reads the map.

import { isProviderKind, isRuntimeKind, type ProviderKind, type RuntimeKind } from './runtime/types.js';

export const MODEL_PROFILE_IDS = [
  'premium_reasoning',
  'build_strong',
  'analysis_efficient',
  'routine_lowcost',
] as const;

export type ModelProfileId = (typeof MODEL_PROFILE_IDS)[number];

export function isModelProfileId(v: unknown): v is ModelProfileId {
  return typeof v === 'string' && (MODEL_PROFILE_IDS as readonly string[]).includes(v);
}

/** Where a profile runs: the model, and optionally the runtime/provider that executes it. */
export interface ProfileTarget {
  model: string;
  runtime?: RuntimeKind;
  provider?: ProviderKind;
}

export interface ModelProfileMap {
  // Every profile id must be present. A partial map is rejected rather than
  // silently falling back per-profile, because a missing entry would resolve
  // to the install default and quietly move an agent to a different model.
  profiles: Record<ModelProfileId, string>;
  /** Same entries with the optional runtime/provider (Phase 4b). */
  targets: Record<ModelProfileId, ProfileTarget>;
  version?: string;
}

export type ModelProfileMapState =
  | { ok: true; map: ModelProfileMap }
  | { ok: false; error: string };

function parseTarget(id: string, value: unknown): { ok: true; target: ProfileTarget } | { ok: false; error: string } {
  if (typeof value === 'string') {
    if (!value.trim()) return { ok: false, error: `profile_map_missing_or_empty:${id}` };
    return { ok: true, target: { model: value.trim() } };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.model !== 'string' || !o.model.trim()) return { ok: false, error: `profile_map_missing_or_empty:${id}` };
    const target: ProfileTarget = { model: o.model.trim() };
    if (o.runtime !== undefined) {
      if (!isRuntimeKind(o.runtime)) return { ok: false, error: `profile_map_unknown_runtime:${id}:${String(o.runtime).slice(0, 30)}` };
      target.runtime = o.runtime;
    }
    if (o.provider !== undefined) {
      if (!isProviderKind(o.provider)) return { ok: false, error: `profile_map_unknown_provider:${id}:${String(o.provider).slice(0, 30)}` };
      target.provider = o.provider;
    }
    return { ok: true, target };
  }
  return { ok: false, error: `profile_map_missing_or_empty:${id}` };
}

export function validateModelProfileMap(raw: unknown): ModelProfileMapState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'profile_map_not_an_object' };
  }
  const o = raw as Record<string, unknown>;
  if (!o.profiles || typeof o.profiles !== 'object' || Array.isArray(o.profiles)) {
    return { ok: false, error: 'profile_map_missing_profiles' };
  }
  const src = o.profiles as Record<string, unknown>;
  const profiles = {} as Record<ModelProfileId, string>;
  const targets = {} as Record<ModelProfileId, ProfileTarget>;
  for (const id of MODEL_PROFILE_IDS) {
    const parsed = parseTarget(id, src[id]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    profiles[id] = parsed.target.model;
    targets[id] = parsed.target;
  }
  for (const key of Object.keys(src)) {
    if (!isModelProfileId(key)) return { ok: false, error: `profile_map_unknown_profile:${key}` };
  }
  return {
    ok: true,
    map: { profiles, targets, version: typeof o.version === 'string' ? o.version : undefined },
  };
}

export type ModelResolutionSource = 'explicit_model' | 'model_profile' | 'default';

export interface ModelResolution {
  model: string;
  source: ModelResolutionSource;
  // Set when the config named a profile that could not be honoured. The caller
  // decides how loud to be; resolution itself never throws.
  error?: string;
}

export interface AgentModelConfig {
  // Legacy and still highest precedence: a concrete model id or alias.
  model?: unknown;
  // Optional generic tier.
  modelProfile?: unknown;
}

/**
 * Resolver precedence (spec 5.3): explicit model > modelProfile > install default.
 *
 * Failure semantics matter more than the happy path here. An unknown profile id
 * or an unusable map must NOT silently fall through to the default model -- that
 * is exactly the "no silent model change" the acceptance criteria forbid, since
 * it would move an agent onto a different provider without anyone asking. Those
 * cases resolve to the default AND carry an `error`, so the caller surfaces the
 * misconfiguration instead of running on a model nobody chose.
 *
 * `aliasResolver` is injected so this module stays free of agent-config imports.
 */
export function resolveAgentModelFromConfig(
  config: AgentModelConfig,
  mapState: ModelProfileMapState | null,
  defaultModel: string,
  aliasResolver: (raw: string) => string,
): ModelResolution {
  // 1. Explicit model always wins, exactly as before this layer existed.
  if (typeof config.model === 'string' && config.model.trim()) {
    return { model: aliasResolver(config.model.trim()), source: 'explicit_model' };
  }

  // 2. modelProfile, when one is configured.
  if (config.modelProfile !== undefined && config.modelProfile !== null && config.modelProfile !== '') {
    if (!isModelProfileId(config.modelProfile)) {
      return { model: defaultModel, source: 'default', error: `unknown_model_profile:${String(config.modelProfile).slice(0, 40)}` };
    }
    if (!mapState) {
      return { model: defaultModel, source: 'default', error: 'model_profile_map_missing' };
    }
    if (!mapState.ok) {
      return { model: defaultModel, source: 'default', error: mapState.error };
    }
    return { model: aliasResolver(mapState.map.profiles[config.modelProfile]), source: 'model_profile' };
  }

  // 3. Install default.
  return { model: defaultModel, source: 'default' };
}

/** The (runtime, provider, model) target a profile maps to, alias-resolved; null when the map is unusable. */
export function resolveProfileTarget(
  profile: ModelProfileId,
  mapState: ModelProfileMapState | null,
  aliasResolver: (raw: string) => string,
): ProfileTarget | null {
  if (!mapState || !mapState.ok) return null;
  const t = mapState.map.targets[profile];
  return { ...t, model: aliasResolver(t.model) };
}
