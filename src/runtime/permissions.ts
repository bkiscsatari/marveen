// Claude Code permission patterns, evaluated in-process (Phase 4).
//
// The security profiles (templates/profiles/*.json) and each agent's
// .claude/settings.json express permissions in Claude Code's syntax:
//   Read(/abs/path/**)   Write(...)   Edit(...)      -- path globs
//   Bash(ls:*)  Bash(curl -X POST:*)  Bash(git push:*) -- command prefix (":*" = any args)
//   WebFetch(*)  WebSearch(*)  mcp__server__tool  mcp__server__*  ScheduleWakeup
// Claude Code enforces these itself; the native-api runtime has to, so the
// same list guards its built-in tools. Semantics mirror Claude Code:
// deny wins over allow; with permissionMode 'strict' anything not allowed is
// denied; with 'permissive' (bypass) only the deny list applies.
// Pure: no I/O.

export interface PermissionRule {
  tool: string
  /** Argument pattern inside the parentheses, or null for a bare tool name. */
  arg: string | null
}

export function parsePermissionRule(raw: string): PermissionRule | null {
  const t = raw.trim()
  if (!t) return null
  const m = t.match(/^([A-Za-z0-9_*-]+)(?:\((.*)\))?$/s)
  if (!m) return null
  return { tool: m[1], arg: m[2] ?? null }
}

/** Expand ${AGENT_DIR} / ${HOME} placeholders the profile templates use. */
export function expandPlaceholders(raw: string, vars: { AGENT_DIR: string; HOME: string }): string {
  return raw.replace(/\$\{AGENT_DIR\}/g, vars.AGENT_DIR).replace(/\$\{HOME\}/g, vars.HOME)
}

/** Glob -> RegExp: `**` = any path segment(s), `*` = within a segment, `?` = one char. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        // `/**/` or trailing `/**` matches zero or more segments
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function toolNameMatches(pattern: string, tool: string): boolean {
  if (pattern === tool) return true
  if (pattern.includes('*')) return globToRegExp(pattern).test(tool)
  return false
}

function argMatches(rule: PermissionRule, tool: string, arg: string | null): boolean {
  if (rule.arg === null || rule.arg === '*') return true
  if (arg === null) return false
  if (tool === 'Bash') {
    // "prefix:*" -> the command starts with prefix (word boundary); "exact" -> equal.
    if (rule.arg.endsWith(':*')) {
      const prefix = rule.arg.slice(0, -2)
      return arg === prefix || arg.startsWith(prefix + ' ')
    }
    return arg === rule.arg
  }
  // Path-like tools: glob on the (absolute) argument.
  return globToRegExp(rule.arg).test(arg)
}

export interface PermissionSet {
  allow: PermissionRule[]
  deny: PermissionRule[]
  permissionMode: 'permissive' | 'strict'
}

export function buildPermissionSet(
  lists: { allow?: string[]; deny?: string[] } | null | undefined,
  permissionMode: 'permissive' | 'strict',
  vars: { AGENT_DIR: string; HOME: string },
): PermissionSet {
  const parse = (xs: string[] | undefined): PermissionRule[] =>
    (xs ?? []).map((x) => parsePermissionRule(expandPlaceholders(x, vars))).filter((r): r is PermissionRule => r !== null)
  return { allow: parse(lists?.allow), deny: parse(lists?.deny), permissionMode }
}

export type PermissionDecision = { allowed: true; rule?: PermissionRule } | { allowed: false; rule?: PermissionRule; reason: string }

/**
 * Decide for one tool invocation. `arg` is the tool's primary argument in the
 * form Claude Code matches on: an absolute path for Read/Write/Edit, the
 * command line for Bash, the URL for WebFetch, null otherwise.
 */
export function checkPermission(set: PermissionSet, tool: string, arg: string | null): PermissionDecision {
  for (const r of set.deny) {
    if (toolNameMatches(r.tool, tool) && argMatches(r, tool, arg)) {
      return { allowed: false, rule: r, reason: `denied by rule ${formatRule(r)}` }
    }
  }
  if (set.permissionMode === 'permissive') return { allowed: true }
  for (const r of set.allow) {
    if (toolNameMatches(r.tool, tool) && argMatches(r, tool, arg)) return { allowed: true, rule: r }
  }
  return { allowed: false, reason: `not in the allow list (strict profile): ${tool}${arg ? `(${arg.slice(0, 80)})` : ''}` }
}

export function formatRule(r: PermissionRule): string {
  return r.arg === null ? r.tool : `${r.tool}(${r.arg})`
}
