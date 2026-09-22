// Marveen's own Telegram bridge (Phase 5): replaces the Claude Code channels
// plugin so the main agent can run on ANY runtime.
//
// Inbound: grammY long polling -> access policy (access.ts) -> ledger
// (direction='in') -> `<channel …>` envelope (envelope.ts) -> deliver() into
// the main agent's runtime. Attachments are downloaded into the bridge state
// dir and referenced by path in the envelope (image_path / attachment_path),
// like the plugin did. Outbound goes through the MCP server (mcp-server.ts)
// the agent calls, or the bridge's own sendText for system notices.
//
// The inbound handler is written against an injected `deps` object so it is
// unit-testable without Telegram; grammY is only touched in start()/stop().

import { Bot, GrammyError, HttpError, type Context } from 'grammy'
import { mkdirSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { logger } from '../logger.js'
import { buildChannelEnvelope } from './envelope.js'
import { decideAccess, readAccess, writeAccess, type AccessFile } from './access.js'
import { logInbound } from './ledger.js'

export interface InboundMessage {
  chatId: string
  messageId: string
  senderId: string
  senderName?: string
  isGroup: boolean
  chatTitle?: string
  text: string
  tsIso: string
  replyToMessageId?: string
  photo?: { fileId: string; ext: string }
  document?: { fileId: string; fileName?: string; mime?: string }
  voice?: { fileId: string; ext: string }
}

export interface BridgeDeps {
  agentId: string
  stateDir: string
  readAccess: () => AccessFile
  writeAccess: (a: AccessFile) => void
  /** Deliver an envelope to the main agent's runtime. */
  deliver: (envelope: string, meta: InboundMessage) => Promise<void>
  /** Direct send for bridge-originated notices (pairing code, errors). */
  sendText: (chatId: string, text: string) => Promise<void>
  /** Download a Telegram file to `dest`; returns the path or null. */
  download?: (fileId: string, dest: string) => Promise<string | null>
  ledger?: { logInbound: typeof logInbound }
  now?: () => number
}

export interface InboundOutcome {
  action: 'delivered' | 'denied' | 'pairing-issued' | 'pairing-pending' | 'error'
  detail?: string
  envelope?: string
}

export async function handleInbound(msg: InboundMessage, deps: BridgeDeps): Promise<InboundOutcome> {
  const access = deps.readAccess()
  const d = decideAccess(access, { senderId: msg.senderId, chatId: msg.chatId, isGroup: msg.isGroup, senderName: msg.senderName }, deps.now?.() ?? Date.now())
  if (d.kind === 'deny') {
    logger.info({ chatId: msg.chatId, senderId: msg.senderId, reason: d.reason }, 'telegram-bridge: inbound denied')
    return { action: 'denied', detail: d.reason }
  }
  if (d.kind === 'pairing-issued' || d.kind === 'pairing-pending') {
    deps.writeAccess(access)
    if (d.kind === 'pairing-issued') {
      await deps.sendText(msg.chatId, `Párosítási kód: ${d.code}\nA tulajdonos a dashboardon vagy a CLI-ben hagyja jóvá (marveen channel pair ${d.code}). A csatornán érkező jóváhagyást a rendszer nem fogad el.`).catch(() => { /* best effort */ })
    }
    return { action: d.kind, detail: d.code }
  }
  // Attachments -> files under the state dir, referenced from the envelope.
  let imagePath: string | undefined
  let attachmentKind: string | undefined
  let attachmentFileId: string | undefined
  let attachmentPath: string | undefined
  if (deps.download) {
    const inbox = join(deps.stateDir, 'inbox')
    try { mkdirSync(inbox, { recursive: true }) } catch { /* best effort */ }
    if (msg.photo) imagePath = (await deps.download(msg.photo.fileId, join(inbox, `${msg.messageId}.${msg.photo.ext}`))) ?? undefined
    if (msg.document) { attachmentKind = 'document'; attachmentFileId = msg.document.fileId; attachmentPath = (await deps.download(msg.document.fileId, join(inbox, `${msg.messageId}-${(msg.document.fileName ?? 'file').replace(/[^A-Za-z0-9._-]/g, '_')}`))) ?? undefined }
    if (msg.voice) { attachmentKind = 'voice'; attachmentFileId = msg.voice.fileId; attachmentPath = (await deps.download(msg.voice.fileId, join(inbox, `${msg.messageId}.${msg.voice.ext}`))) ?? undefined }
  } else {
    if (msg.document) { attachmentKind = 'document'; attachmentFileId = msg.document.fileId }
    if (msg.voice) { attachmentKind = 'voice'; attachmentFileId = msg.voice.fileId }
  }
  const text = msg.text || (msg.photo ? '[kép]' : msg.voice ? '[hangüzenet]' : msg.document ? `[fájl: ${msg.document.fileName ?? 'melléklet'}]` : '')
  ;(deps.ledger ?? { logInbound }).logInbound(deps.agentId, msg.chatId, msg.messageId, text, msg.tsIso, { kind: attachmentKind, fileId: attachmentFileId })
  const envelope = buildChannelEnvelope({
    chatId: msg.chatId, messageId: msg.messageId, user: msg.senderName ?? msg.senderId, ts: msg.tsIso, text,
    imagePath, attachmentKind, attachmentFileId, attachmentPath, replyToMessageId: msg.replyToMessageId, chatTitle: msg.chatTitle,
  })
  try {
    await deps.deliver(envelope, msg)
    return { action: 'delivered', envelope }
  } catch (err) {
    logger.error({ err, chatId: msg.chatId }, 'telegram-bridge: delivery failed')
    return { action: 'error', detail: (err as Error).message, envelope }
  }
}

/** grammY Context -> our neutral inbound shape. Exported for tests. */
export function inboundFromContext(ctx: Context): InboundMessage | null {
  const m = ctx.message
  if (!m || !m.from) return null
  const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup'
  const largest = m.photo?.[m.photo.length - 1]
  return {
    chatId: String(m.chat.id),
    messageId: String(m.message_id),
    senderId: String(m.from.id),
    senderName: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || String(m.from.id),
    isGroup,
    chatTitle: 'title' in m.chat ? m.chat.title : undefined,
    text: m.text ?? m.caption ?? '',
    tsIso: new Date(m.date * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    replyToMessageId: m.reply_to_message ? String(m.reply_to_message.message_id) : undefined,
    photo: largest ? { fileId: largest.file_id, ext: 'jpg' } : undefined,
    document: m.document ? { fileId: m.document.file_id, fileName: m.document.file_name, mime: m.document.mime_type } : undefined,
    voice: m.voice ? { fileId: m.voice.file_id, ext: 'ogg' } : m.video_note ? { fileId: m.video_note.file_id, ext: 'mp4' } : undefined,
  }
}

export interface TelegramBridge {
  start(): Promise<void>
  stop(): Promise<void>
  sendText(chatId: string, text: string): Promise<number | null>
  typing(chatId: string): Promise<void>
  botUsername(): string | null
}

export function createTelegramBridge(opts: {
  token: string
  agentId: string
  stateDir: string
  deliver: BridgeDeps['deliver']
  accessPath?: string
}): TelegramBridge {
  const bot = new Bot(opts.token)
  let username: string | null = null
  const sendText = async (chatId: string, text: string): Promise<number | null> => {
    const r = await bot.api.sendMessage(chatId, text)
    return r.message_id
  }
  const download = async (fileId: string, dest: string): Promise<string | null> => {
    try {
      const f = await bot.api.getFile(fileId)
      if (!f.file_path) return null
      const res = await fetch(`https://api.telegram.org/file/bot${opts.token}/${f.file_path}`)
      if (!res.ok || !res.body) return null
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
      return dest
    } catch (err) {
      logger.warn({ err, fileId }, 'telegram-bridge: attachment download failed')
      return null
    }
  }
  const deps: BridgeDeps = {
    agentId: opts.agentId,
    stateDir: opts.stateDir,
    readAccess: () => readAccess(opts.accessPath),
    writeAccess: (a) => writeAccess(a, opts.accessPath),
    deliver: opts.deliver,
    sendText: async (c, t) => { await sendText(c, t) },
    download,
  }
  bot.on('message', async (ctx) => {
    const msg = inboundFromContext(ctx)
    if (!msg) return
    const out = await handleInbound(msg, deps)
    logger.info({ chatId: msg.chatId, messageId: msg.messageId, action: out.action, detail: out.detail?.slice(0, 80) }, 'telegram-bridge: inbound')
  })
  bot.catch((err) => {
    const e = err.error
    if (e instanceof GrammyError) logger.error({ desc: e.description, code: e.error_code }, 'telegram-bridge: Bot API error')
    else if (e instanceof HttpError) logger.error({ err: e }, 'telegram-bridge: HTTP error')
    else logger.error({ err: e }, 'telegram-bridge: handler error')
  })
  let started = false
  return {
    async start() {
      if (started) return
      started = true
      mkdirSync(opts.stateDir, { recursive: true })
      const me = await bot.api.getMe()
      username = me.username ?? null
      // Not awaited: bot.start() resolves only when polling stops. 409 Conflict
      // (another poller on the same token) surfaces through bot.catch/log.
      void bot.start({ drop_pending_updates: false, onStart: () => logger.info({ username }, 'telegram-bridge: polling started') })
        .catch((err) => logger.error({ err }, 'telegram-bridge: polling stopped with error'))
    },
    async stop() { if (started) { started = false; await bot.stop() } },
    sendText,
    async typing(chatId) { try { await bot.api.sendChatAction(chatId, 'typing') } catch { /* best effort */ } },
    botUsername: () => username,
  }
}
