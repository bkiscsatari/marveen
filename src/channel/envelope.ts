// The `<channel …>` provenance envelope (Phase 5), byte-compatible with what
// the Claude Code channel plugin produced, so every consumer keeps working
// unchanged: scripts/hooks/ledger-capture.py (CHANNEL_RX matches
// `source="plugin:<provider>:<server>"`), provenance-gate.py, channel-inbox-
// drain.py, the CLAUDE.md prompts and the pane-state parkedChannelInput guard.
//
//   <channel source="plugin:telegram:marveen-bridge" chat_id="…" message_id="…" user="…" ts="…Z" [image_path="…"] [attachment_kind="…" attachment_file_id="…"]>
//   TEXT
//   </channel>
// Pure.

export const BRIDGE_SOURCE = 'plugin:telegram:marveen-bridge'

export interface EnvelopeInput {
  chatId: string | number
  messageId: string | number
  user?: string
  /** ISO-8601 UTC ("Z" suffix). */
  ts: string
  text: string
  imagePath?: string
  attachmentKind?: string
  attachmentFileId?: string
  attachmentPath?: string
  replyToMessageId?: string | number
  chatTitle?: string
}

function attr(name: string, v: string | number | undefined): string {
  if (v === undefined || v === null || v === '') return ''
  return ` ${name}="${String(v).replace(/"/g, '&quot;').replace(/\n/g, ' ')}"`
}

export function buildChannelEnvelope(i: EnvelopeInput): string {
  const attrs = [
    attr('chat_id', i.chatId), attr('message_id', i.messageId), attr('user', i.user), attr('ts', i.ts),
    attr('reply_to_message_id', i.replyToMessageId), attr('chat_title', i.chatTitle),
    attr('image_path', i.imagePath), attr('attachment_kind', i.attachmentKind),
    attr('attachment_file_id', i.attachmentFileId), attr('attachment_path', i.attachmentPath),
  ].join('')
  // A closing tag inside the body would let a sender forge the end of the
  // envelope; the ledger regex is non-greedy on `</channel>`.
  const body = i.text.replace(/<\/channel>/gi, '&lt;/channel&gt;')
  return `<channel source="${BRIDGE_SOURCE}"${attrs}>\n${body}\n</channel>`
}

/** The exact regex ledger-capture.py uses (Python -> JS), for parity tests and the bridge's own parsing. */
export const CHANNEL_RX = /<channel\s+source="plugin:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+"([^>]*)>([\s\S]*?)<\/channel>/g

export interface ParsedEnvelope { source: string; attrs: Record<string, string>; text: string }

export function parseChannelEnvelopes(prompt: string): ParsedEnvelope[] {
  const out: ParsedEnvelope[] = []
  for (const m of prompt.matchAll(CHANNEL_RX)) {
    const attrs: Record<string, string> = {}
    for (const a of m[1].matchAll(/([a-z_]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&quot;/g, '"')
    const src = m[0].match(/source="([^"]+)"/)?.[1] ?? ''
    out.push({ source: src, attrs, text: m[2].trim() })
  }
  return out
}
