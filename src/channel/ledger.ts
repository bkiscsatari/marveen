// TypeScript twin of scripts/hooks/ledger_lib.py (Phase 5): the rolling
// conversation transcript in `conversation_log`. Same table, same UNIQUE
// (agent_id, chat_id, direction, message_id) idempotency, same "open
// question" definition (last inbound with no later outbound), so the Python
// hooks (ledger-capture / ledger-outbound / telegram-reply-guard / ledger-
// replay) and the bridge read and write one ledger.

import { getDb } from '../db.js'

export interface LedgerRow {
  id: number
  agent_id: string
  chat_id: string
  direction: 'in' | 'out'
  message_id: string | null
  text: string | null
  ts: string | null
  created_at: number
  attachment_kind: string | null
  attachment_file_id: string | null
}

function nowUnix(): number { return Math.floor(Date.now() / 1000) }

export function logInbound(agentId: string, chatId: string | number, messageId: string | number, text: string, ts: string, att: { kind?: string; fileId?: string } = {}): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at, attachment_kind, attachment_file_id)
    VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)
  `).run(String(agentId), String(chatId), String(messageId), text, ts, nowUnix(), att.kind ?? null, att.fileId ?? null)
}

export function logOutbound(agentId: string, chatId: string | number, text: string, messageId?: string | number | null): void {
  const now = nowUnix()
  getDb().prepare(`
    INSERT OR IGNORE INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
    VALUES (?, ?, 'out', ?, ?, ?, ?)
  `).run(String(agentId), String(chatId), messageId != null ? String(messageId) : null, text, new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), now)
}

/** The last inbound with no later outbound, or null (= answered / nothing). */
export function openQuestion(agentId: string): LedgerRow | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM conversation_log WHERE agent_id = ? AND direction = 'in' ORDER BY created_at DESC, id DESC LIMIT 1`).get(String(agentId)) as LedgerRow | undefined
  if (!row) return null
  const later = db.prepare(`SELECT 1 FROM conversation_log WHERE agent_id = ? AND direction = 'out' AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1`).get(String(agentId), row.created_at, row.created_at, row.id)
  return later ? null : row
}

export function recent(agentId: string, limit = 20): LedgerRow[] {
  const rows = getDb().prepare(`SELECT * FROM conversation_log WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(String(agentId), limit) as LedgerRow[]
  return rows.reverse()
}
