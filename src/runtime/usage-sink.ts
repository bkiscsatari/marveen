// Usage sink for runtime adapters that report usage as EVENTS (Phase 1).
//
// The token_usage table stays the single sink (dashboard, cost pages, Jev
// shadow-routing reports all read it). Transcript mining (web/token-usage.ts)
// keeps filling it for claude-tmux sessions; event-reporting runtimes insert
// their per-turn records here. Same UNIQUE(agent, session_id, timestamp,
// input_tokens, output_tokens) index guards against double counting.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import type { UsageRecord } from './types.js'

export function recordRuntimeUsage(
  agent: string,
  u: UsageRecord,
  extra: { contentPreview?: string; toolName?: string; taskTitle?: string; project?: string } = {},
): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name,
        task_title, project, runtime, provider, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, session_id, timestamp, input_tokens, output_tokens) DO NOTHING
    `).run(
      agent,
      u.sessionRef ?? `${u.runtime}:${agent}`,
      Math.floor(u.timestamp / 1000),
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens ?? 0,
      u.cacheCreationTokens ?? 0,
      u.thinkingTokens ?? 0,
      u.model,
      extra.contentPreview ?? null,
      extra.toolName ?? null,
      extra.taskTitle ?? null,
      extra.project ?? null,
      u.runtime,
      u.provider,
      u.costUsd ?? null,
    )
  } catch (err) {
    logger.warn({ err, agent }, 'usage-sink: failed to record runtime usage')
  }
}
