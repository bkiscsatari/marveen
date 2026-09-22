// Reply-guard for runtimes without a native Stop hook (Phase 5).
//
// On Claude Code the telegram-reply-guard.py Stop hook blocks a turn that
// leaves the owner's last question unanswered. Codex/Gemini/native runtimes
// have no such stop; the bridge re-creates the guarantee from the OUTSIDE by
// watching the ledger after a delivery: if the agent went idle and the
// inbound is still open, it nudges once (bounded), mirroring the hook's
// own rules (acks need no reply, stale questions are not nagged, max blocks).
// Pure decision + the same ack lexicon as the Python hook.

const ACK_WORDS = new Set([
  'ok', 'oke', 'okk', 'okés', 'okes', 'rendben', 'rdb', 'köszi', 'koszi', 'kösz', 'kosz', 'köszönöm', 'koszonom',
  'thx', 'thanks', 'ty', 'thank you', 'szuper', 'super', 'remek', 'tökéletes', 'tokeletes', 'jó', 'jo', 'oksa',
])
const EMOJI_ACK = ['👍', '🙏', '👌', '❤️', '👏', '🎉', '✅', '🆗', '+1']

export function isAck(text: string | null | undefined): boolean {
  let t = (text ?? '').trim().toLowerCase()
  if (!t) return true
  for (const e of EMOJI_ACK) t = t.split(e).join(' ')
  t = t.replace(/[.!?…,]/g, ' ')
  const tokens = t.split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  return tokens.every((tok) => ACK_WORDS.has(tok))
}

export interface ReplyGuardFacts {
  /** The open inbound (last inbound without a later outbound), or null. */
  open: { text: string | null; createdAtUnix: number; messageId: string | null } | null
  agentState: 'idle' | 'busy' | 'blocked' | 'auth' | 'dead' | 'unknown'
  nowUnix: number
  /** Nudges already sent for this message id. */
  nudgesSent: number
  /** Seconds since the delivery (or the last nudge). */
  sinceLastActionS: number
  graceS?: number
  staleS?: number
  maxNudges?: number
}

export type ReplyGuardAction = { kind: 'none'; reason: string } | { kind: 'nudge'; text: string }

export function decideReplyGuard(f: ReplyGuardFacts): ReplyGuardAction {
  const grace = f.graceS ?? 45
  const stale = f.staleS ?? 1800
  const max = f.maxNudges ?? 3
  if (!f.open) return { kind: 'none', reason: 'no open question' }
  if (isAck(f.open.text)) return { kind: 'none', reason: 'inbound is an acknowledgement' }
  if (f.nowUnix - f.open.createdAtUnix > stale) return { kind: 'none', reason: 'open question is stale' }
  if (f.nudgesSent >= max) return { kind: 'none', reason: 'nudge budget exhausted' }
  if (f.agentState !== 'idle') return { kind: 'none', reason: `agent is ${f.agentState}` }
  if (f.sinceLastActionS < grace) return { kind: 'none', reason: 'within grace window' }
  const snippet = (f.open.text ?? '').replace(/\s+/g, ' ').slice(0, 160)
  return {
    kind: 'nudge',
    text: `[reply-guard] A tulajdonos utolsó üzenete még válasz nélkül van (message_id=${f.open.messageId ?? '?'}): "${snippet}". Válaszolj rá MOST a reply toollal, mielőtt bármi mást csinálsz.`,
  }
}
