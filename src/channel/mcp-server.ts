#!/usr/bin/env node
// `plugin-telegram-bridge` MCP server (Phase 5): the agent's outbound side of
// the Marveen Telegram bridge, runtime-independent (stdio MCP works in Claude
// Code, Codex, Gemini and the native loop alike).
//
// Registered under the server name `plugin-telegram-bridge` so the tool ids
// become `mcp__plugin_telegram_bridge__reply` etc. -- which the existing
// governance hooks already match (`^mcp__plugin_[A-Za-z0-9_]+__reply$` in
// ledger-outbound.py, the reply matchers in .claude/settings.json). The
// `reply` result text is `sent (id: N)`, the exact phrase ledger-outbound.py
// parses for the message id. Every send is also written to the ledger here
// (INSERT OR IGNORE on the same message id keeps the hook's row from
// duplicating it).
//
// Env: TELEGRAM_BOT_TOKEN (or the install .env), MARVEEN_AGENT_ID (ledger
// attribution), ALLOWED_CHAT_ID (chat_id=0 shorthand -> owner chat).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, existsSync, createWriteStream, mkdirSync, realpathSync } from 'node:fs'
import { join, basename, dirname, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { Bot, InputFile } from 'grammy'
import { allowedOutboundChats, type OutboundAccess as AccessFile } from './outbound-policy.js'

// Underscores on purpose: every runtime then derives the same tool id
// (`mcp__plugin_telegram_bridge__reply`) without depending on how a given
// CLI sanitises hyphens in server names.
export const SERVER_NAME = 'plugin_telegram_bridge'

function readEnvLine(root: string, key: string): string | undefined {
  try {
    const m = readFileSync(join(root, '.env'), 'utf-8').match(new RegExp(`^\\s*${key}=(.*)$`, 'm'))
    return m?.[1]?.trim().replace(/^"|"$/g, '')
  } catch { return undefined }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): { token: string; agentId: string; ownerChat: string | null; root: string; agentDir: string } {
  const root = env.MARVEEN_PROJECT_ROOT ?? process.cwd()
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || readEnvLine(root, 'TELEGRAM_BOT_TOKEN') || ''
  const agentId = env.MARVEEN_AGENT_ID?.trim() || readEnvLine(root, 'MAIN_AGENT_ID') || 'marveen'
  const owner = env.ALLOWED_CHAT_ID?.trim() || readEnvLine(root, 'ALLOWED_CHAT_ID') || ''
  // The agent's workspace = this stdio child's cwd (every runtime starts MCP
  // servers in the agent dir); MARVEEN_AGENT_DIR overrides.
  const agentDir = env.MARVEEN_AGENT_DIR?.trim() || process.cwd()
  return { token, agentId, ownerChat: owner && owner !== '0' ? owner : null, root, agentDir }
}

/** chat_id=0 / "" is the plugin's shorthand for "the owner chat". */
export function resolveChatId(raw: string | number | undefined, ownerChat: string | null): string | null {
  const v = raw === undefined || raw === null ? '' : String(raw).trim()
  if (!v || v === '0') return ownerChat
  return v
}

/**
 * Outbound chat check: only the owner, the allowFrom senders and the allowed
 * groups of store/channel-access.json (re-read per call, so an approval takes
 * effect at once). The first version sent to ANY chat_id.
 */
export function outboundChatAllowed(chat: string, cfg: { root: string; ownerChat: string | null }): boolean {
  let access: AccessFile = {}
  try { access = JSON.parse(readFileSync(join(cfg.root, 'store', 'channel-access.json'), 'utf-8')) as AccessFile } catch { access = {} }
  return allowedOutboundChats(access, cfg.ownerChat).has(String(chat))
}

// Files that must never leave through send_file, wherever they sit.
const SECRET_FILE_RX = /(^|\/)(\.env(\..*)?|\.dashboard-token|.*\.pem|.*\.key|id_(rsa|ed25519|ecdsa)(\.pub)?|auth\.json|oauth_creds\.json|\.credentials\.json|credentials(\.json)?|.*\.db(-wal|-shm)?|vault.*)$/i

/**
 * send_file may only send a file that (after realpath) lives under the agent's
 * working directory or the bridge's own dirs -- and never a
 * secret-looking file. The first version read any path it was given, so a
 * prompt-injected agent could post .env or the dashboard token to the chat.
 */
export function sendableFile(path: string, cfg: { root: string; agentDir: string }): { ok: true; real: string } | { ok: false; reason: string } {
  let real: string
  try { real = realpathSync(path) } catch { return { ok: false, reason: `no such file: ${path}` } }
  if (SECRET_FILE_RX.test(real)) return { ok: false, reason: 'refused: looks like a secret or a database file' }
  const roots = [cfg.agentDir, join(cfg.root, 'store', 'channel-bridge'), join(cfg.root, 'store', 'channel-inbox')]
    .map((r) => { try { return realpathSync(r) } catch { return r } })
  const storeDir = (() => { try { return realpathSync(join(cfg.root, 'store')) } catch { return join(cfg.root, 'store') } })()
  const under = (r: string) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep)
  if (!roots.some(under)) return { ok: false, reason: `refused: ${real} is outside the agent workspace and the bridge outbox` }
  // The agent dir of the MAIN agent is the install root: its store/ is not sendable.
  if (under(storeDir) && !roots.slice(1, 3).some(under)) return { ok: false, reason: 'refused: files under store/ are not sendable' }
  return { ok: true, real }
}

/** A destination that does not overwrite an existing file (name-1.ext, name-2.ext, …). */
export function uniquePath(dest: string): string {
  if (!existsSync(dest)) return dest
  const dot = dest.lastIndexOf('.')
  const slash = dest.lastIndexOf('/')
  const [stem, ext] = dot > slash + 1 ? [dest.slice(0, dot), dest.slice(dot)] : [dest, '']
  for (let i = 1; i < 10_000; i++) { const p = `${stem}-${i}${ext}`; if (!existsSync(p)) return p }
  return `${stem}-${Date.now()}${ext}`
}

/** Telegram allows 4096 chars per message; split on paragraph/line boundaries. */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

async function ledgerOutbound(root: string, agentId: string, chatId: string, text: string, messageId: number | null): Promise<void> {
  // Direct sqlite write (no dashboard import: this process is a stdio child of the agent).
  try {
    const { default: Database } = await import('better-sqlite3')
    const p = join(root, 'store', 'claudeclaw.db')
    if (!existsSync(p)) return
    const db = new Database(p)
    try {
      db.pragma('busy_timeout = 10000')
      const now = Math.floor(Date.now() / 1000)
      db.prepare(`INSERT OR IGNORE INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at) VALUES (?, ?, 'out', ?, ?, ?, ?)`)
        .run(agentId, chatId, messageId != null ? String(messageId) : null, text, new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), now)
    } finally { db.close() }
  } catch (err) {
    process.stderr.write(`plugin-telegram-bridge: ledger write failed: ${(err as Error).message}\n`)
  }
}

export function buildServer(cfg: ReturnType<typeof resolveConfig>, bot: Bot): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' })
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })

  server.registerTool('reply', {
    description: 'Send a text reply to a Telegram chat. chat_id 0 or empty = the owner chat. Long texts are split automatically. Returns "sent (id: N)".',
    inputSchema: { chat_id: z.union([z.string(), z.number()]).optional(), text: z.string().min(1), reply_to_message_id: z.union([z.string(), z.number()]).optional(), parse_mode: z.enum(['HTML', 'MarkdownV2']).optional() },
  }, async ({ chat_id, text: body, reply_to_message_id, parse_mode }) => {
    const chat = resolveChatId(chat_id, cfg.ownerChat)
    if (!chat) return fail('reply: no chat_id and no owner chat configured (ALLOWED_CHAT_ID)')
    if (!outboundChatAllowed(chat, cfg)) return fail(`reply: chat ${chat} is not an allowed chat (owner / channel-access.json allowFrom / groups)`)
    const ids: number[] = []
    for (const chunk of splitForTelegram(body)) {
      try {
        const r = await bot.api.sendMessage(chat, chunk, { ...(parse_mode ? { parse_mode } : {}), ...(reply_to_message_id && !ids.length ? { reply_parameters: { message_id: Number(reply_to_message_id) } } : {}) })
        ids.push(r.message_id)
      } catch (err) {
        if (parse_mode) { const r = await bot.api.sendMessage(chat, chunk); ids.push(r.message_id) } else throw err
      }
    }
    await ledgerOutbound(cfg.root, cfg.agentId, chat, body, ids[0] ?? null)
    return text(ids.length > 1 ? `sent ${ids.length} parts (ids: ${ids.join(', ')})` : `sent (id: ${ids[0]})`)
  })

  server.registerTool('send_file', {
    description: 'Send a local file as a Telegram document (or photo when photo=true).',
    inputSchema: { chat_id: z.union([z.string(), z.number()]).optional(), path: z.string(), caption: z.string().optional(), photo: z.boolean().optional() },
  }, async ({ chat_id, path, caption, photo }) => {
    const chat = resolveChatId(chat_id, cfg.ownerChat)
    if (!chat) return fail('send_file: no chat_id and no owner chat configured')
    if (!outboundChatAllowed(chat, cfg)) return fail(`send_file: chat ${chat} is not an allowed chat (owner / channel-access.json allowFrom / groups)`)
    const okFile = sendableFile(path, cfg)
    if (!okFile.ok) return fail(`send_file: ${okFile.reason}`)
    const file = new InputFile(okFile.real, basename(okFile.real))
    const r = photo ? await bot.api.sendPhoto(chat, file, caption ? { caption } : undefined) : await bot.api.sendDocument(chat, file, caption ? { caption } : undefined)
    await ledgerOutbound(cfg.root, cfg.agentId, chat, caption ?? `[file: ${basename(path)}]`, r.message_id)
    return text(`sent (id: ${r.message_id})`)
  })

  server.registerTool('edit_message', {
    description: 'Edit the text of a message the bot sent earlier.',
    inputSchema: { chat_id: z.union([z.string(), z.number()]).optional(), message_id: z.union([z.string(), z.number()]), text: z.string().min(1) },
  }, async ({ chat_id, message_id, text: body }) => {
    const chat = resolveChatId(chat_id, cfg.ownerChat)
    if (!chat) return fail('edit_message: no chat')
    if (!outboundChatAllowed(chat, cfg)) return fail(`edit_message: chat ${chat} is not an allowed chat (owner / channel-access.json allowFrom / groups)`)
    await bot.api.editMessageText(chat, Number(message_id), body.slice(0, 4096))
    return text(`edited (id: ${message_id})`)
  })

  server.registerTool('react', {
    description: 'React to a message with an emoji (e.g. 👍).',
    inputSchema: { chat_id: z.union([z.string(), z.number()]).optional(), message_id: z.union([z.string(), z.number()]), emoji: z.string().min(1) },
  }, async ({ chat_id, message_id, emoji }) => {
    const chat = resolveChatId(chat_id, cfg.ownerChat)
    if (!chat) return fail('react: no chat')
    if (!outboundChatAllowed(chat, cfg)) return fail(`react: chat ${chat} is not an allowed chat (owner / channel-access.json allowFrom / groups)`)
    await bot.api.setMessageReaction(chat, Number(message_id), [{ type: 'emoji', emoji: emoji as never }])
    return text('reacted')
  })

  server.registerTool('typing', {
    description: 'Show the "typing…" indicator in a chat for a few seconds.',
    inputSchema: { chat_id: z.union([z.string(), z.number()]).optional() },
  }, async ({ chat_id }) => {
    const chat = resolveChatId(chat_id, cfg.ownerChat)
    if (!chat) return fail('typing: no chat')
    if (!outboundChatAllowed(chat, cfg)) return fail(`typing: chat ${chat} is not an allowed chat (owner / channel-access.json allowFrom / groups)`)
    await bot.api.sendChatAction(chat, 'typing')
    return text('ok')
  })

  server.registerTool('download_attachment', {
    description: 'Download a Telegram attachment by file_id into the bridge inbox and return its local path.',
    inputSchema: { file_id: z.string(), file_name: z.string().optional() },
  }, async ({ file_id, file_name }) => {
    const f = await bot.api.getFile(file_id)
    if (!f.file_path) return fail('download_attachment: no file_path from Telegram')
    const dir = join(cfg.root, 'store', 'channel-inbox')
    mkdirSync(dir, { recursive: true })
    const dest = uniquePath(join(dir, (file_name ?? basename(f.file_path)).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')))
    const res = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${f.file_path}`)
    if (!res.ok || !res.body) return fail(`download_attachment: HTTP ${res.status}`)
    mkdirSync(dirname(dest), { recursive: true })
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
    return text(dest)
  })

  return server
}

async function main(): Promise<void> {
  const cfg = resolveConfig()
  if (!cfg.token) {
    process.stderr.write('plugin-telegram-bridge: TELEGRAM_BOT_TOKEN missing (env or install .env)\n')
    process.exit(1)
  }
  const bot = new Bot(cfg.token)
  const server = buildServer(cfg, bot)
  await server.connect(new StdioServerTransport())
}

const isEntry = process.argv[1] && /mcp-server\.(ts|[cm]?js)$/.test(process.argv[1])
if (isEntry) main().catch((err) => { process.stderr.write(`plugin-telegram-bridge: fatal ${(err as Error).message}\n`); process.exit(1) })
