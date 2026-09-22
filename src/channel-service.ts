// Standalone entry for the Marveen channel bridge (Phase 5) -- the drop-in
// ExecStart for <service>-channels.service when the dashboard should not own
// the bridge:   node dist/channel-service.js
// Runs the main agent on its configured runtime + the Telegram bridge, and
// exits cleanly on SIGTERM so systemd's Restart=always re-launches it.

import { initDatabase } from './db.js'
import { logger } from './logger.js'
import { startChannelBridge, stopChannelBridge, channelBridgeMode } from './channel/service.js'

async function main(): Promise<void> {
  if (channelBridgeMode() !== 'marveen') {
    logger.error('channel-service: CHANNEL_BRIDGE is not "marveen" -- nothing to do (the plugin path is channels.sh)')
    process.exit(2)
  }
  initDatabase()
  const r = await startChannelBridge()
  if (!r.ok) { logger.error({ detail: r.detail }, 'channel-service: bridge failed to start'); process.exit(1) }
  logger.info({ detail: r.detail }, 'channel-service: running')
  const stop = (): void => { void stopChannelBridge().finally(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((err) => { logger.error({ err }, 'channel-service: fatal'); process.exit(1) })
