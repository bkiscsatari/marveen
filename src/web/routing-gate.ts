// The measurement gate for Jev routing (B1), in CODE rather than only in
// docs/model-routing.md.
//
// The rule the owner set: no routing decision is APPLIED (MODEL_ROUTING=
// background|all) before at least 100 labelled shadow rows have been measured,
// with the threshold checked on a held-out half, and an explicit approval.
// Before this file the rule lived in prose; flipping the env value applied
// suggestions at once.
//
// The evidence is store/model-routing-calibration.json. Its measured fields
// are written by the Jev repo's report (scripts/shadow_marveen_routing.py
// --write-calibration); `approvedAt` + `approvedModes` are the owner's
// sign-off and are added by hand (or --approve). Without a passing file an
// apply mode degrades to 'shadow' -- logging continues, nothing switches --
// and the dashboard shows why.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import type { RoutingMode } from '../model-router.js'

export const CALIBRATION_PATH = join(STORE_DIR, 'model-routing-calibration.json')
export const MIN_LABELLED_ROWS = 100

export interface RoutingCalibration {
  labelledRows?: unknown
  fitRows?: unknown
  holdoutRows?: unknown
  holdoutAgreement?: unknown
  generatedAt?: unknown
  approvedAt?: unknown
  approvedModes?: unknown
}

export interface GateVerdict {
  allowed: boolean
  reason: string
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Pure: may `mode` APPLY suggestions given this calibration evidence? */
export function evaluateRoutingGate(mode: RoutingMode, cal: RoutingCalibration | null): GateVerdict {
  if (mode !== 'background' && mode !== 'all') return { allowed: true, reason: 'not an apply mode' }
  if (!cal) return { allowed: false, reason: 'no calibration file (store/model-routing-calibration.json)' }
  const labelled = num(cal.labelledRows)
  if (labelled === null || labelled < MIN_LABELLED_ROWS) {
    return { allowed: false, reason: `labelled rows ${labelled ?? 0} < ${MIN_LABELLED_ROWS}` }
  }
  const holdout = num(cal.holdoutRows)
  if (holdout === null || holdout <= 0 || num(cal.holdoutAgreement) === null) {
    return { allowed: false, reason: 'no held-out measurement' }
  }
  if (typeof cal.approvedAt !== 'string' || !cal.approvedAt.trim()) {
    return { allowed: false, reason: 'not approved by the owner (approvedAt missing)' }
  }
  const modes = Array.isArray(cal.approvedModes) ? cal.approvedModes.filter((m): m is string => typeof m === 'string') : []
  // 'all' approval covers 'background' (it is a superset); the reverse is not true.
  const ok = modes.includes(mode) || (mode === 'background' && modes.includes('all'))
  if (!ok) return { allowed: false, reason: `mode ${mode} not in approvedModes [${modes.join(', ')}]` }
  return { allowed: true, reason: `calibrated on ${labelled} rows, approved ${cal.approvedAt}` }
}

export function readRoutingCalibration(path: string = CALIBRATION_PATH): RoutingCalibration | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RoutingCalibration : null
  } catch {
    return null
  }
}
