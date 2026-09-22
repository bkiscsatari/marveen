// Raw event-stream capture for fixture recording and field debugging.
//
// Set MARVEEN_RUNTIME_DUMP_DIR=<dir> and every headless adapter appends the
// raw JSONL lines it receives to <dir>/<runtime>-<agent>-<ts>.jsonl. This is
// how src/__tests__/fixtures/* get re-recorded when a CLI changes its event
// shapes (see scripts/record-runtime-fixture.sh). Off by default; never throws.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function streamDumper(runtime: string, agentId: string, env: NodeJS.ProcessEnv = process.env): ((line: string) => void) | null {
  const dir = env.MARVEEN_RUNTIME_DUMP_DIR?.trim()
  if (!dir) return null
  try { mkdirSync(dir, { recursive: true }) } catch { return null }
  const file = join(dir, `${runtime}-${agentId.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.jsonl`)
  return (line: string) => { try { appendFileSync(file, line + '\n') } catch { /* best effort */ } }
}
