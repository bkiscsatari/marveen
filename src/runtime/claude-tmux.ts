// `claude-tmux` runtime adapter (Phase 0).
//
// The pre-existing fleet path -- an interactive Claude Code TUI per agent
// inside a tmux session, driven by send-keys / capture-pane -- wrapped behind
// the AgentRuntime interface WITHOUT moving any of it. Everything this file
// calls still lives in web/agent-process.ts, pane-state.ts and agent.ts;
// consumers that migrate to the interface get byte-identical behaviour while
// the other adapters (headless, Codex, Gemini, native) grow beside it.

import { execFileSync } from 'node:child_process'
import { makeLazyBinResolver } from '../platform.js'
import { runAgent } from '../agent.js'
import { detectPaneState } from '../pane-state.js'
import { detectsUsageLimit } from '../model-fallback.js'
import { contextLimitForModel } from '../context-guard.js'
import {
  agentRunState,
  agentSessionName,
  capturePane,
  sendPromptToSession,
  startAgentProcess,
  stopAgentProcess,
} from '../web/agent-process.js'
import { readAgentRemoteHost } from '../web/agent-config.js'
import type {
  AgentHandle,
  AgentRuntime,
  AgentSpec,
  AgentState,
  HealthProbeResult,
  RunOptions,
  RunResult,
  RuntimeCapabilities,
  SendOptions,
  SendOutcome,
  UsageCursor,
  UsageRecord,
} from './types.js'

const claudeBin = makeLazyBinResolver('claude')

// The login / 401 chrome Claude Code renders when its subscription auth is
// gone. Mirrors WORKER_AUTH_FAILURE_RX in web/agent-worker.ts.
const AUTH_FAILURE_RX = /(Please run \/login|Not logged in|API Error: 401|Invalid authentication|OAuth token (?:has )?expired)/i

/** Pure: map a captured pane to the runtime-neutral AgentState. Exported for tests. */
export function classifyPane(pane: string | null): AgentState {
  if (pane == null) return 'unknown'
  if (AUTH_FAILURE_RX.test(pane)) return 'auth'
  if (detectsUsageLimit(pane)) return 'blocked'
  switch (detectPaneState(pane, { mergeTypingAsBusy: true })) {
    case 'idle': return 'idle'
    case 'busy': return 'busy'
    case 'error': return 'blocked'
    default: return 'unknown'
  }
}

export const claudeTmuxRuntime: AgentRuntime = {
  kind: 'claude-tmux',

  capabilities(agent: AgentSpec): RuntimeCapabilities {
    return {
      interactive: true,
      supportsResume: true, // --continue (channel-less agents only; see startAgentProcess)
      supportsHooks: 'native',
      supportsMcp: true,
      supportsChannelsPlugin: true,
      reportsUsage: 'transcript',
      contextWindow: contextLimitForModel(agent.model),
    }
  },

  async spawn(agent: AgentSpec, opts: { fresh?: boolean } = {}): Promise<AgentHandle> {
    const r = await startAgentProcess(agent.id, opts)
    if (!r.ok) throw new Error(r.error ?? `startAgentProcess(${agent.id}) failed`)
    return {
      agentId: agent.id,
      runtime: 'claude-tmux',
      sessionRef: agentSessionName(agent.id),
      host: readAgentRemoteHost(agent.id),
    }
  },

  async send(handle: AgentHandle, prompt: string, opts: SendOptions = {}): Promise<SendOutcome> {
    return sendPromptToSession(handle.sessionRef, prompt, handle.host ?? null, {
      waitForIdle: opts.waitForIdle,
      onBusyTimeout: opts.onBusyTimeout,
      idleTimeoutMs: opts.idleTimeoutMs,
    })
  },

  // One-shot generation goes through the existing worker/SDK path in
  // src/agent.ts (a shared interactive worker session, or the Agent SDK as
  // rollback). Unchanged semantics: text=null + reason on a blocked result.
  async run(agent: AgentSpec, prompt: string, opts: RunOptions = {}): Promise<RunResult> {
    const r = await runAgent(
      prompt,
      opts.resume,
      undefined,
      opts.allowTools ?? false,
      opts.cwd ?? agent.dir,
      opts.env,
      { timeoutMs: opts.timeoutMs, timeoutAsError: opts.timeoutAsError },
    )
    return {
      text: r.text,
      blocked: r.text === null,
      reason: r.error,
      sessionRef: r.newSessionId,
    }
  },

  async state(handle: AgentHandle): Promise<AgentState> {
    if (agentRunState(handle.agentId) !== 'running') return 'dead'
    return classifyPane(capturePane(handle.sessionRef, handle.host ?? null))
  },

  async stop(handle: AgentHandle): Promise<void> {
    await stopAgentProcess(handle.agentId)
  },

  // Transcript mining stays fleet-wide in web/token-usage.ts (collectTokenUsage
  // sweeps every ~/.claude/projects dir on its own cadence and writes the
  // token_usage table). Per-handle incremental reads arrive with the usage
  // refactor (plan section 7); until then this reports nothing rather than
  // double-counting what the sweep already inserted.
  async usageSince(_handle: AgentHandle, cursor: UsageCursor | null): Promise<{ records: UsageRecord[]; cursor: UsageCursor }> {
    return { records: [], cursor: cursor ?? { value: null } }
  },

  async healthProbe(_agent: AgentSpec): Promise<HealthProbeResult> {
    try {
      const out = execFileSync(claudeBin(), ['--version'], { encoding: 'utf-8', timeout: 15_000 }).trim()
      return { ok: true, detail: out }
    } catch (err) {
      return { ok: false, detail: `claude --version failed: ${(err as Error).message}` }
    }
  },
}

export default claudeTmuxRuntime
