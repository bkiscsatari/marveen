// Channel service orchestration (Phase 5): the main agent on ANY runtime +
// the Marveen Telegram bridge, wired together.
//
//   CHANNEL_BRIDGE=marveen  -> startChannelBridge() (from the dashboard boot, or
//                              the standalone channel-service entry)
//   CHANNEL_BRIDGE=plugin   -> nothing here; channels.sh + the Claude plugin as before
//
// The main agent's runtime comes from its agent-config.json (`runtime`,
// `provider`, `authMode`; PROJECT_ROOT/agent-config.json for the main agent).
// In bridge mode an Anthropic main agent defaults to claude-headless: the tmux
// TUI path is channels.sh's domain and stays on the plugin until Phase 6.
// The bridge's MCP server is injected as an extra MCP server into whatever
// runtime runs the agent, so `reply` is the same tool everywhere.

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { logger } from '../logger.js'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID } from '../config.js'
import { getRuntime } from '../runtime/registry.js'
import { buildAgentSpec } from '../runtime/agent-spec.js'
import { createTelegramBridge, type TelegramBridge } from './telegram-bridge.js'
import { migrateFromPlugin, ACCESS_PATH } from './access.js'
import { openQuestion } from './ledger.js'
import { decideReplyGuard } from './reply-guard.js'
import type { AgentHandle, AgentRuntime, AgentSpec, RuntimeKind } from '../runtime/types.js'
import type { McpServerDef } from '../runtime/bundle-render.js'

export type ChannelBridgeMode = 'plugin' | 'marveen'

export function channelBridgeMode(env: NodeJS.ProcessEnv = process.env): ChannelBridgeMode {
  return (env.CHANNEL_BRIDGE || '').trim().toLowerCase() === 'marveen' ? 'marveen' : 'plugin'
}

/** The bridge MCP server definition every runtime gets for the main agent. */
export function bridgeMcpServerDef(opts: { root?: string; token?: string; agentId?: string; ownerChat?: string | null } = {}): McpServerDef {
  const root = opts.root ?? PROJECT_ROOT
  const entry = existsSync(join(root, 'dist', 'channel', 'mcp-server.js'))
    ? join(root, 'dist', 'channel', 'mcp-server.js')
    : join(root, 'src', 'channel', 'mcp-server.ts')
  const isTs = entry.endsWith('.ts')
  return {
    command: process.execPath,
    args: isTs ? [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry] : [entry],
    env: {
      MARVEEN_PROJECT_ROOT: root,
      MARVEEN_AGENT_ID: opts.agentId ?? MAIN_AGENT_ID,
      TELEGRAM_BOT_TOKEN: opts.token ?? TELEGRAM_BOT_TOKEN,
      ALLOWED_CHAT_ID: opts.ownerChat ?? ALLOWED_CHAT_ID,
    },
  }
}

/** Main-agent spec for bridge mode: claude-tmux is swapped for claude-headless (see header). */
export function mainAgentSpecForBridge(): AgentSpec {
  const spec = buildAgentSpec(MAIN_AGENT_ID, 'main')
  const runtime: RuntimeKind = spec.runtime === 'claude-tmux' ? 'claude-headless' : spec.runtime
  return { ...spec, runtime, extraMcpServers: { ...(spec.extraMcpServers ?? {}), plugin_telegram_bridge: bridgeMcpServerDef() } }
}

interface ServiceState {
  runtime: AgentRuntime
  spec: AgentSpec
  handle: AgentHandle
  bridge: TelegramBridge
  timers: NodeJS.Timeout[]
  nudges: Map<string, number>
  lastActionAt: number
}
let state: ServiceState | null = null

export async function startChannelBridge(): Promise<{ ok: boolean; detail: string }> {
  if (state) return { ok: true, detail: 'already running' }
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, detail: 'TELEGRAM_BOT_TOKEN missing' }
  const migrated = migrateFromPlugin({ seedAllow: ALLOWED_CHAT_ID ? [ALLOWED_CHAT_ID] : [] })
  logger.info({ migrated, path: ACCESS_PATH }, 'channel-bridge: access file')
  const spec = mainAgentSpecForBridge()
  const runtime = await getRuntime(spec.runtime)
  const handle = await runtime.spawn(spec, { fresh: false })
  logger.info({ runtime: spec.runtime, provider: spec.provider, model: spec.model, handle: handle.sessionRef }, 'channel-bridge: main agent spawned')
  const stateDir = join(STORE_DIR, 'channel-bridge')
  const st: ServiceState = { runtime, spec, handle, bridge: null as unknown as TelegramBridge, timers: [], nudges: new Map(), lastActionAt: Date.now() }
  st.bridge = createTelegramBridge({
    token: TELEGRAM_BOT_TOKEN, agentId: MAIN_AGENT_ID, stateDir,
    deliver: async (envelope) => {
      st.lastActionAt = Date.now()
      const out = await runtime.send(handle, envelope, { envelope: 'channel', waitForIdle: true })
      if (out !== 'sent') logger.warn({ out }, 'channel-bridge: delivery not sent')
    },
  })
  await st.bridge.start()
  state = st
  // Typing indicator while the agent works; reply-guard nudges when it idles with an open question.
  st.timers.push(setInterval(() => { void tick(st) }, 5_000))
  return { ok: true, detail: `bridge up (@${st.bridge.botUsername() ?? '?'}) on ${spec.runtime}/${spec.model}` }
}

async function tick(st: ServiceState): Promise<void> {
  try {
    const agentState = await st.runtime.state(st.handle)
    const open = openQuestion(MAIN_AGENT_ID)
    if (agentState === 'busy' && open) await st.bridge.typing(open.chat_id)
    const key = open?.message_id ?? ''
    const d = decideReplyGuard({
      open: open ? { text: open.text, createdAtUnix: open.created_at, messageId: open.message_id } : null,
      agentState, nowUnix: Math.floor(Date.now() / 1000),
      nudgesSent: st.nudges.get(key) ?? 0,
      sinceLastActionS: (Date.now() - st.lastActionAt) / 1000,
    })
    if (d.kind === 'nudge') {
      st.nudges.set(key, (st.nudges.get(key) ?? 0) + 1)
      st.lastActionAt = Date.now()
      logger.warn({ messageId: key, n: st.nudges.get(key) }, 'channel-bridge: reply-guard nudge')
      await st.runtime.send(st.handle, d.text, { envelope: 'none', waitForIdle: true })
    }
    if (agentState === 'dead') {
      logger.warn('channel-bridge: main agent handle dead -- respawning')
      st.handle = await st.runtime.spawn(st.spec, { fresh: false })
    }
  } catch (err) {
    logger.warn({ err }, 'channel-bridge: tick failed')
  }
}

export async function stopChannelBridge(): Promise<void> {
  if (!state) return
  const st = state; state = null
  for (const t of st.timers) clearInterval(t)
  try { await st.bridge.stop() } catch { /* best effort */ }
  try { await st.runtime.stop(st.handle) } catch { /* best effort */ }
}

export function channelBridgeStatus(): { running: boolean; runtime?: RuntimeKind; model?: string; bot?: string | null } {
  return state ? { running: true, runtime: state.spec.runtime, model: state.spec.model, bot: state.bridge.botUsername() } : { running: false }
}
