// Agent-runtime abstraction (agent-agnostic Marveen, Phase 0).
//
// Three INDEPENDENT axes that the pre-Phase-0 code derived from a single
// model-id prefix:
//
//   runtime  -- WHO runs the agent loop (Claude Code TUI in tmux, Claude Code
//               headless, OpenAI Codex CLI, Google Gemini CLI, or Marveen's
//               own native-API tool loop);
//   provider -- WHOSE model answers (anthropic, openai, google, deepseek, ...);
//   authMode -- HOW it is paid for (a subscription login the CLI owns, or an
//               API key from the vault).
//
// Every consumer that used to reach for tmux/claude directly (message router,
// kanban dispatch, background tasks, workers, fallback runner) will talk to an
// `AgentRuntime` instead. This file is pure types + constants: no I/O, so the
// pure resolvers next to it stay unit-testable without a filesystem.

export const RUNTIME_KINDS = [
  'claude-tmux',
  'claude-headless',
  'codex-cli',
  'gemini-cli',
  'native-api',
  'minimax-cli',
] as const
export type RuntimeKind = (typeof RUNTIME_KINDS)[number]

export function isRuntimeKind(v: unknown): v is RuntimeKind {
  return typeof v === 'string' && (RUNTIME_KINDS as readonly string[]).includes(v)
}

export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'minimax',
  'openrouter',
  'ollama',
  'moonshot',
  'zhipu',
] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export function isProviderKind(v: unknown): v is ProviderKind {
  return typeof v === 'string' && (PROVIDER_KINDS as readonly string[]).includes(v)
}

export type AuthMode = 'subscription' | 'api'

// What kind of session the spec describes. Affects the default runtime
// (e.g. a background task never needs an interactive pane).
export type AgentRole = 'main' | 'sub' | 'worker' | 'background'

export interface RuntimeCapabilities {
  /** A live, screen-scrapable TUI pane exists (claude-tmux only). */
  interactive: boolean
  /** The runtime can continue an earlier conversation (--continue / --resume / history). */
  supportsResume: boolean
  /** How Marveen's governance hooks are enforced on this runtime:
   *  'native'        -- the CLI runs scripts/hooks/* itself (Claude Code hooks, or a shim);
   *  'policy-engine' -- only Marveen's in-process PolicyEngine / MCP gatekeeper enforces them;
   *  'none'          -- no enforcement (must be surfaced loudly on the dashboard). */
  supportsHooks: 'native' | 'policy-engine' | 'none'
  supportsMcp: boolean
  /** The Claude Code channels plugin can be attached (claude-tmux only). */
  supportsChannelsPlugin: boolean
  /** Where usage numbers come from: structured events, transcript mining, or nothing. */
  reportsUsage: 'events' | 'transcript' | 'none'
  /** Context window the runtime believes the model has, in tokens. */
  contextWindow: number
}

/** MCP server definition (Claude Code .mcp.json shape; bundle-render's McpServerDef is structurally identical). */
export interface McpServerSpec {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  type?: string
  [k: string]: unknown
}

export interface AgentSpec {
  /** Agent id (directory name under agents/, or MAIN_AGENT_ID). */
  id: string
  /** Working directory of the agent (its bundle root). */
  dir: string
  role: AgentRole
  /** Concrete, alias-resolved model id (MODEL_ID_RE-valid). */
  model: string
  runtime: RuntimeKind
  provider: ProviderKind
  authMode: AuthMode
  securityProfile: string
  displayName?: string
  channelProvider?: string | null
  /** MCP servers injected by Marveen itself (e.g. the Telegram bridge), merged over the agent's .mcp.json in every runtime. */
  extraMcpServers?: Record<string, McpServerSpec>
}

export interface AgentHandle {
  agentId: string
  runtime: RuntimeKind
  /** tmux session name, CLI session id, or a runtime_sessions row id. */
  sessionRef: string
  /** ssh host for a remote claude-tmux agent; null/undefined = local. */
  host?: string | null
}

export type AgentState = 'idle' | 'busy' | 'blocked' | 'auth' | 'dead' | 'unknown'

export type PromptEnvelope = 'channel' | 'scheduled-task' | 'trusted-peer' | 'untrusted' | 'none'

export interface SendOptions {
  /** Provenance envelope the caller already wrapped the prompt in (informational). */
  envelope?: PromptEnvelope
  /** Wait for the session to be idle before delivering (default true). */
  waitForIdle?: boolean
  /** What to do when the idle wait times out: deliver anyway or abort. */
  onBusyTimeout?: 'send' | 'abort'
  idleTimeoutMs?: number
}

export type SendOutcome = 'sent' | 'aborted-busy' | 'skipped-locked'

export interface UsageRecord {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  thinkingTokens?: number
  model: string
  provider: ProviderKind
  runtime: RuntimeKind
  costUsd?: number
  /** Epoch ms of the turn this record describes. */
  timestamp: number
  /** Runtime-specific session/thread id the record belongs to. */
  sessionRef?: string
}

export interface ToolCallRecord {
  name: string
  input?: unknown
  ok?: boolean
}

export interface RunResult {
  /** Generated text, or null when the run must NOT be used as content
   *  (policy block, API error, timeout-as-error) -- mirrors
   *  classifyAgentResult in src/agent.ts. */
  text: string | null
  blocked: boolean
  reason?: string
  usage?: UsageRecord
  /** Session/thread id that can be passed back as `resume`. */
  sessionRef?: string
  toolCalls?: ToolCallRecord[]
}

export interface RunOptions {
  /** Continue a prior session/thread (runtime-specific id). */
  resume?: string
  timeoutMs?: number
  /** Return a structured error instead of apology text on timeout. */
  timeoutAsError?: boolean
  /** Allow file/shell tools (default false: pure text generation). */
  allowTools?: boolean
  cwd?: string
  env?: Record<string, string | undefined>
  /** Streaming text chunks as the model produces them (live output views). */
  onProgress?: (chunk: string) => void
}

export interface HealthProbeResult {
  ok: boolean
  detail: string
}

export interface UsageCursor {
  /** Opaque, runtime-owned position marker. */
  value: unknown
}

export interface AgentRuntime {
  readonly kind: RuntimeKind
  capabilities(agent: AgentSpec): RuntimeCapabilities
  /** Start (or restart) a long-lived session for the agent. */
  spawn(agent: AgentSpec, opts?: { fresh?: boolean }): Promise<AgentHandle>
  /** Deliver a prompt into a long-lived session; fire-and-forget from the caller's view. */
  send(handle: AgentHandle, prompt: string, opts?: SendOptions): Promise<SendOutcome>
  /** One-shot headless run (background task, worker request, scaffold generation). */
  run(agent: AgentSpec, prompt: string, opts?: RunOptions): Promise<RunResult>
  state(handle: AgentHandle): Promise<AgentState>
  stop(handle: AgentHandle): Promise<void>
  /** Usage records produced since `cursor` (null = from the beginning). */
  usageSince(handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }>
  /** Can this runtime authenticate and answer for this agent right now? */
  healthProbe(agent: AgentSpec): Promise<HealthProbeResult>
}
