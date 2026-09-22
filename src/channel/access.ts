// Channel access control for the Marveen Telegram bridge (Phase 5).
//
// Same file shape the Claude Code telegram plugin kept in
// ~/.claude/channels/telegram/access.json (dmPolicy, allowFrom, groups,
// pending), now owned by Marveen at store/channel-access.json and migrated
// once from the plugin file when present. Policies:
//   allowlist (default)  only allowFrom senders / listed groups are delivered
//   pairing              unknown senders get a 6-digit code; the OWNER approves
//                        it from the dashboard/CLI (never from the channel)
//   disabled             nothing is delivered
// Pure logic with injected I/O so it is unit-testable.

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomInt } from 'node:crypto'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { STORE_DIR } from '../config.js'

export type DmPolicy = 'allowlist' | 'pairing' | 'disabled'

export interface PendingEntry { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number; name?: string }

export interface AccessFile {
  dmPolicy?: DmPolicy
  allowFrom?: string[]
  groups?: Record<string, unknown>
  pending?: Record<string, PendingEntry>
}

export const ACCESS_PATH = join(STORE_DIR, 'channel-access.json')
export const PLUGIN_ACCESS_PATH = join(homedir(), '.claude', 'channels', 'telegram', 'access.json')
const PENDING_TTL_MS = 24 * 60 * 60 * 1000

export function readAccess(path: string = ACCESS_PATH): AccessFile {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as AccessFile } catch { return {} }
}

export function writeAccess(data: AccessFile, path: string = ACCESS_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/** One-time migration from the plugin's file; never overwrites an existing Marveen file. */
export function migrateFromPlugin(opts: { from?: string; to?: string; seedAllow?: string[] } = {}): { migrated: boolean; source: 'plugin' | 'seed' | 'existing' } {
  const to = opts.to ?? ACCESS_PATH
  if (existsSync(to)) return { migrated: false, source: 'existing' }
  const from = opts.from ?? PLUGIN_ACCESS_PATH
  if (existsSync(from)) {
    const src = readAccess(from)
    writeAccess({ dmPolicy: src.dmPolicy ?? 'allowlist', allowFrom: (src.allowFrom ?? []).map(String), groups: src.groups ?? {}, pending: {} }, to)
    return { migrated: true, source: 'plugin' }
  }
  writeAccess({ dmPolicy: 'allowlist', allowFrom: (opts.seedAllow ?? []).filter((x) => x && x !== '0'), groups: {}, pending: {} }, to)
  return { migrated: true, source: 'seed' }
}

export type AccessDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'pairing-issued'; code: string }
  | { kind: 'pairing-pending'; code: string }

/**
 * Decide for one inbound message. Mutates `access` (pending map) when pairing
 * issues or refreshes a code; the caller persists it.
 */
export function decideAccess(access: AccessFile, msg: { senderId: string; chatId: string; isGroup: boolean; senderName?: string }, now = Date.now()): AccessDecision {
  const policy = access.dmPolicy ?? 'allowlist'
  if (policy === 'disabled') return { kind: 'deny', reason: 'channel disabled' }
  const allow = (access.allowFrom ?? []).map(String)
  if (msg.isGroup) {
    return access.groups && Object.prototype.hasOwnProperty.call(access.groups, msg.chatId)
      ? { kind: 'allow' }
      : { kind: 'deny', reason: 'group not allowed' }
  }
  if (allow.includes(msg.senderId)) return { kind: 'allow' }
  if (policy !== 'pairing') return { kind: 'deny', reason: 'sender not in allowFrom' }
  access.pending ??= {}
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.expiresAt < now) { delete access.pending[code]; continue }
    if (p.senderId === msg.senderId) { p.replies = (p.replies ?? 0) + 1; return { kind: 'pairing-pending', code } }
  }
  const code = String(randomInt(100000, 999999))
  access.pending[code] = { senderId: msg.senderId, chatId: msg.chatId, createdAt: now, expiresAt: now + PENDING_TTL_MS, replies: 0, name: msg.senderName }
  return { kind: 'pairing-issued', code }
}

/** Owner-side approval (dashboard/CLI). Returns the approved sender id or null. */
export function approvePending(access: AccessFile, code: string, now = Date.now()): string | null {
  const p = access.pending?.[code]
  if (!p || p.expiresAt < now) return null
  access.allowFrom = [...new Set([...(access.allowFrom ?? []).map(String), p.senderId])]
  delete access.pending![code]
  if (!Object.keys(access.pending!).length) access.dmPolicy = 'allowlist'
  return p.senderId
}
