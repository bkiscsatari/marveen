// AgentSpec assembly from on-disk agent config (Phase 1).
//
// The one I/O-bearing helper in src/runtime/: reads agents/<id>/agent-config.json
// through the existing accessors in web/agent-config.ts and folds in the pure
// runtime/provider/authMode resolution. Consumers (background tasks, message
// router, fallback runner) call this instead of re-deriving the axes.

import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import {
  agentDir,
  readAgentModel,
  readAgentDisplayName,
  readAgentSecurityProfile,
  readAgentChannelProvider,
  resolveAgentRuntimeSpec,
} from '../web/agent-config.js'
import { logger } from '../logger.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRole, AgentSpec } from './types.js'

/** The profile's permissionMode; anything but an explicit 'strict' is permissive (as Claude Code reads it). */
export function profilePermissionMode(securityProfile: string, root: string = PROJECT_ROOT): 'permissive' | 'strict' {
  if (!/^[A-Za-z0-9_-]+$/.test(securityProfile)) return 'permissive'
  try {
    const p = JSON.parse(readFileSync(join(root, 'templates', 'profiles', `${securityProfile}.json`), 'utf-8')) as { permissionMode?: string }
    return p.permissionMode === 'strict' ? 'strict' : 'permissive'
  } catch { return 'permissive' }
}

export function buildAgentSpec(agentId: string, role?: AgentRole): AgentSpec {
  const isMain = agentId === MAIN_AGENT_ID
  const r = role ?? (isMain ? 'main' : 'sub')
  const resolved = resolveAgentRuntimeSpec(agentId, r)
  if (resolved.warnings.length) {
    logger.warn({ agent: agentId, warnings: resolved.warnings }, 'agent-spec: runtime config warnings')
  }
  return {
    id: agentId,
    dir: isMain ? PROJECT_ROOT : agentDir(agentId),
    role: r,
    model: readAgentModel(agentId),
    runtime: resolved.runtime,
    provider: resolved.provider,
    authMode: resolved.authMode,
    securityProfile: readAgentSecurityProfile(agentId),
    // Wired so the CLI adapters' strict branches (codex read-only sandbox,
    // gemini auto_edit, mcode smart) are reachable; before, nothing set it.
    permissionMode: profilePermissionMode(readAgentSecurityProfile(agentId)),
    displayName: readAgentDisplayName(agentId),
    channelProvider: readAgentChannelProvider(agentId),
  }
}
