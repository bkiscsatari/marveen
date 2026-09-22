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
import { readFileSync, existsSync, createWriteStream, mkdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { Bot, InputFile } from 'grammy'

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

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): { token: string; agentId: string; ownerChat: string | null; root: string } {
  const root = env.MARVEEN_PROJECT_ROOT ?? process.cwd()
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || readEnvLine(root, 'TELEGRAM_BOT_TOKEN') || ''
  const agentId = env.MARVEEN_AGENT_ID?.trim() || readEnvLine(root, 'MAIN_AGENT_ID') || 'marveen'
  const owner = env.ALLOWED_CHAT_ID?.trim() || readEnvLine(root, 'ALLOWED_CHAT_ID') || ''
  return { token, agentId, ownerChat: owner && owner !== '0' ? owner : null, root }
}

/** chat_id=0 / "" is the plugin's shorthand for "the owner chat". */
export function resolveChatId(raw: string | number | undefined, ownerChat: string | null): string | null {
  const v = raw === undefined || raw === null ? '' : String(raw).trim()
  if (!v || v === '0') return ownerChat
  return v
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
    if (!existsSync(path)) return fail(`send_file: no such file: ${path}`)
    const file = new InputFile(path, basename(path))
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
    await bot.api.editMessageText(chat, Number(message_id), body.slice(0, 4096))
    return text(`edited (id: ${message_id})`)
  })

  server.registerTool('react', {
    description: 'React to a message with an emoji (e.g. 👍).',
    inputSchema: { chat_id: z.union([z.string(), z.number()]).optional(), message_id: z.union([z.string(), z.number()]), emoji: z.string().min(1) },
  }, async ({ chat_id, message_id, emoji }) => {
    const chat = resolveChatId(chat_id, cfg.ownerChat)
    if (!chat) return fail('react: no chat')
    await bot.api.setMessageReaction(chat, Number(message_id), [{ type: 'emoji', emoji: emoji as never }])
    return text('reacted')
  })

  server.registerTool('typing', {
    description: 'Show the "typing…" indicator in a chat for a few seconds.',
    inputSchema: { chat_id: z.union([z.string(), z.number()]).optional() },
  }, async ({ chat_id }) => {
    const chat = resolveChatId(chat_id, cfg.ownerChat)
    if (!chat) return fail('typing: no chat')
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
    const dest = join(dir, (file_name ?? basename(f.file_path)).replace(/[^A-Za-z0-9._-]/g, '_'))
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
