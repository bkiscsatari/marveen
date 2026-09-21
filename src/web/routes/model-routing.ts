// Read-only view of the Jev model-routing shadow log (Phase B0).
//
//   GET /api/model-routing            -> { mode, configured, summary[] }
//   GET /api/model-routing/log?agent=&limit=  -> recent rows, newest first
//
// The calibration report itself is produced offline by the Jev repo
// (~/Projects/Jev/scripts/shadow_marveen_routing.py) from the same table
// joined with token_usage; these endpoints exist for the dashboard and for
// a quick curl while the shadow is being brought up.

import { listModelRoutingLog, modelRoutingSummary } from '../../db.js'
import { jevConfigured } from '../jev-client.js'
import { routingMode } from '../model-routing.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleModelRouting(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (method !== 'GET') return false

  if (path === '/api/model-routing') {
    json(res, { mode: routingMode(), configured: jevConfigured(), summary: modelRoutingSummary() })
    return true
  }

  if (path === '/api/model-routing/log') {
    const agent = url.searchParams.get('agent') || undefined
    const limitRaw = parseInt(url.searchParams.get('limit') ?? '50', 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50
    json(res, listModelRoutingLog(limit, agent))
    return true
  }

  return false
}
