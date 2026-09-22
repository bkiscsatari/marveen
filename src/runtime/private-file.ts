// Owner-only file writes for rendered runtime configs (MCP env blocks, hook
// definitions). writeFileSync's `mode` applies only when the file is CREATED,
// so an existing 0644 file would stay world-readable; chmod after the write
// closes that.

import { chmodSync, writeFileSync } from 'node:fs'

export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* not ours to chmod: leave as is */ }
}
