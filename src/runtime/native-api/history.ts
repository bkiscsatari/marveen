// Conversation history for the native-api runtime (Phase 4).
//
// Headless CLIs keep their own transcripts (Claude: ~/.claude/projects,
// Codex: threads, Gemini: per-project sessions). The native loop owns its
// history instead: one row per session in `runtime_sessions`, the messages as
// AI SDK ModelMessage JSON, so `resume` is trivial and provider-independent
// (a session can even move between vendors, as the fallback runner needs).
// Also mirrored to a JSONL transcript under the agent dir so the ledger/
// provenance hooks that read `transcript_path` have something to open.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

export interface RuntimeSessionRow {
  id: string
  agent: string
  runtime: string
  provider: string
  model: string
  messages: ModelMessage[]
  created_at: number
  updated_at: number
  turns: number
}

export function ensureRuntimeSessionsTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      runtime TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      messages TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_runtime_sessions_agent ON runtime_sessions(agent, updated_at)')
}

export function newSessionId(): string {
  return randomUUID()
}

export function loadSession(id: string): RuntimeSessionRow | null {
  ensureRuntimeSessionsTable()
  const row = getDb().prepare('SELECT * FROM runtime_sessions WHERE id = ?').get(id) as (Omit<RuntimeSessionRow, 'messages'> & { messages: string }) | undefined
  if (!row) return null
  let messages: ModelMessage[] = []
  try { messages = JSON.parse(row.messages) as ModelMessage[] } catch { messages = [] }
  return { ...row, messages }
}

export function saveSession(row: Omit<RuntimeSessionRow, 'created_at' | 'updated_at'> & { created_at?: number }): void {
  ensureRuntimeSessionsTable()
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    INSERT INTO runtime_sessions (id, agent, runtime, provider, model, messages, created_at, updated_at, turns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at, turns = excluded.turns, model = excluded.model, provider = excluded.provider
  `).run(row.id, row.agent, row.runtime, row.provider, row.model, JSON.stringify(row.messages), row.created_at ?? now, now, row.turns)
}

export function latestSessionFor(agent: string, runtime: string): RuntimeSessionRow | null {
  ensureRuntimeSessionsTable()
  const row = getDb().prepare('SELECT id FROM runtime_sessions WHERE agent = ? AND runtime = ? ORDER BY updated_at DESC LIMIT 1').get(agent, runtime) as { id: string } | undefined
  return row ? loadSession(row.id) : null
}

/** Best-effort JSONL mirror for hooks that read transcript_path. */
export function appendTranscript(path: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n')
  } catch (err) {
    logger.debug({ err, path }, 'native-api: transcript mirror write failed')
  }
}

/** Keep the stored history bounded: drop the oldest turns past `maxMessages`, never splitting a tool call from its result. */
export function trimHistory(messages: ModelMessage[], maxMessages: number): ModelMessage[] {
  if (messages.length <= maxMessages) return messages
  let start = messages.length - maxMessages
  // Never start on a tool-result message (its call would be missing).
  while (start < messages.length && messages[start].role === 'tool') start++
  return messages.slice(start)
}
