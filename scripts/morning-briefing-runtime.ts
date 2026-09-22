// Runtime-agnostic morning briefing (Phase 5): the same prompt
// scripts/morning-briefing.sh gave `claude -p --channels …`, now run through
// the main agent's runtime with the bridge MCP server attached, so it works
// on Claude, Codex, Gemini or the native loop. Same once-per-day guard.
//   npx tsx scripts/morning-briefing-runtime.ts   (MORNING_FORCE=1 to resend)
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../src/db.js'
import { PROJECT_ROOT, STORE_DIR, ALLOWED_CHAT_ID } from '../src/config.js'
import { getRuntime } from '../src/runtime/registry.js'
import { mainAgentSpecForBridge } from '../src/channel/service.js'
import { logOutbound } from '../src/channel/ledger.js'
import { getProvider } from '../src/channel-provider.js'
import { TELEGRAM_BOT_TOKEN, MAIN_AGENT_ID } from '../src/config.js'

initDatabase()
const stamp = join(STORE_DIR, '.morning-last-sent')
const log = join(STORE_DIR, 'morning.log')
const today = new Date().toISOString().slice(0, 10)
if (process.env.MORNING_FORCE !== '1' && existsSync(stamp) && readFileSync(stamp, 'utf-8').trim() === today) {
  appendFileSync(log, `=== Reggeli napindító ${new Date().toISOString()} -- SKIP: ma már elküldve ===\n`)
  process.exit(0)
}
const chatId = ALLOWED_CHAT_ID && ALLOWED_CHAT_ID !== '0' ? ALLOWED_CHAT_ID : ''
const calendarId = process.env.HEARTBEAT_CALENDAR_ID || 'primary'
const prompt = `Reggeli napindító - készítsd el és küld el Telegramra (chat_id: ${chatId || '0'}).

1. Email check: search_emails az elmúlt 12 órából, szűrd ki a spam/promo emaileket
2. Naptár: list-events a mai napra a ${calendarId} naptárból (Europe/Budapest timezone)
3. AI hírek: WebSearch "AI news [tegnapi dátum]"
4. Küld el Telegramra a reply tool-lal (chat_id: ${chatId || '0'})

Tömör, lényegre törő. Ékezetesen írj magyarul.`

const spec = mainAgentSpecForBridge()
const rt = await getRuntime(spec.runtime)
appendFileSync(log, `=== Reggeli napindító ${new Date().toISOString()} (${spec.runtime}/${spec.model}) ===\n`)
const r = await rt.run(spec, prompt, { allowTools: true, timeoutMs: 15 * 60_000, timeoutAsError: true })
appendFileSync(log, JSON.stringify({ blocked: r.blocked, reason: r.reason, tools: r.toolCalls?.map((t) => t.name), text: r.text?.slice(0, 500) }) + '\n')
// Fallback: the agent answered but never called reply -> send its text directly.
const replied = r.toolCalls?.some((t) => /__reply$/.test(t.name) && t.ok !== false)
if (!r.blocked && r.text && !replied && chatId && TELEGRAM_BOT_TOKEN) {
  const p = getProvider('telegram')
  for (const chunk of p.splitMessage(p.formatMessage(r.text))) await p.sendMessage(TELEGRAM_BOT_TOKEN, chatId, chunk, 'HTML').catch(async () => p.sendMessage(TELEGRAM_BOT_TOKEN, chatId, chunk))
  logOutbound(MAIN_AGENT_ID, chatId, r.text)
}
if (!r.blocked) writeFileSync(stamp, today + '\n')
appendFileSync(log, `=== Kész ${new Date().toISOString()} ===\n`)
process.exit(r.blocked ? 1 : 0)
