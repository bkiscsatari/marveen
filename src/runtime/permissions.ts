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

export interface PlaceholderVars { AGENT_DIR: string; HOME: string; PROJECT_ROOT?: string }

/** Expand ${AGENT_DIR} / ${HOME} / ${PROJECT_ROOT} placeholders the profile templates use. */
export function expandPlaceholders(raw: string, vars: PlaceholderVars): string {
  let out = raw.replace(/\$\{AGENT_DIR\}/g, vars.AGENT_DIR).replace(/\$\{HOME\}/g, vars.HOME)
  if (vars.PROJECT_ROOT) out = out.replace(/\$\{PROJECT_ROOT\}/g, vars.PROJECT_ROOT)
  return out
}

/**
 * Split a shell command line into the simple commands a rule must see.
 * Claude Code checks each part of `a && b`, `a | b`, `a; b`, and the bodies of
 * `$( … )` / backticks; the first native-api version compared the WHOLE line,
 * so `true && rm -rf x` walked past `Bash(rm:*)`. Quote-aware for '…' and "…"
 * (separators inside quotes do not split). Leading `VAR=value` assignments are
 * dropped from each part, as they do not change which program runs.
 * Not a shell parser: heredocs, functions and eval stay out of reach, which is
 * why these rules are a deny list and not a sandbox.
 */
export function splitShellCommand(cmd: string): string[] {
  const parts: string[] = []
  const subs: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && c === '$' && cmd[i + 1] === '(') {
        const end = matchParen(cmd, i + 1)
        subs.push(cmd.slice(i + 2, end))
      } else if (quote === '"' && c === '`') {
        const end = cmd.indexOf('`', i + 1)
        if (end > i) subs.push(cmd.slice(i + 1, end))
      }
      cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue }
    if (c === '$' && cmd[i + 1] === '(') {
      const end = matchParen(cmd, i + 1)
      subs.push(cmd.slice(i + 2, end))
      cur += cmd.slice(i, end + 1)
      i = end
      continue
    }
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1)
      if (end > i) { subs.push(cmd.slice(i + 1, end)); cur += cmd.slice(i, end + 1); i = end; continue }
    }
    // Redirections that contain '&' (2>&1, &>file, <&3) are not separators.
    if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || (cmd[i + 1] === '>' && cmd[i - 1] !== '&'))) { cur += c; continue }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      parts.push(cur)
      cur = ''
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++
      continue
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') { cur += ' '; continue }
    cur += c
  }
  parts.push(cur)
  const out: string[] = []
  for (const p of parts) {
    const t = p.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, '').trim()
    if (t) out.push(t)
  }
  for (const s of subs) out.push(...splitShellCommand(s))
  return out
}

function matchParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) return i }
  }
  return s.length
}

/** Claude Code Bash rule: "prefix:*" (legacy), a space-wildcard glob ("curl *https://*"), or exact. */
export function bashRuleMatches(ruleArg: string, command: string): boolean {
  if (ruleArg.endsWith(':*')) {
    const prefix = ruleArg.slice(0, -2)
    return command === prefix || command.startsWith(prefix + ' ')
  }
  if (ruleArg.includes('*')) {
    const re = ruleArg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${re}$`, 's').test(command)
  }
  return command === ruleArg
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
  if (tool === 'Bash') return bashRuleMatches(rule.arg, arg)
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
  vars: PlaceholderVars,
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
  // A compound command is checked part by part: ANY part hitting a deny rule
  // denies the line, and under 'strict' EVERY part must be allowed. The whole
  // line is checked too, so a rule written against the full text still bites.
  if (tool === 'Bash' && arg !== null) {
    const parts = splitShellCommand(arg)
    if (parts.length > 1 || (parts.length === 1 && parts[0] !== arg.trim())) {
      for (const p of [arg, ...parts]) {
        const d = checkSimple(set, tool, p, 'deny-only')
        if (!d.allowed) return d
      }
      if (set.permissionMode === 'permissive') return { allowed: true }
      for (const p of parts) {
        const d = checkSimple(set, tool, p, 'full')
        if (!d.allowed) return d
      }
      return { allowed: true }
    }
  }
  return checkSimple(set, tool, arg, 'full')
}

function checkSimple(set: PermissionSet, tool: string, arg: string | null, mode: 'full' | 'deny-only'): PermissionDecision {
  for (const r of set.deny) {
    if (toolNameMatches(r.tool, tool) && argMatches(r, tool, arg)) {
      return { allowed: false, rule: r, reason: `denied by rule ${formatRule(r)}` }
    }
  }
  if (mode === 'deny-only' || set.permissionMode === 'permissive') return { allowed: true }
  for (const r of set.allow) {
    if (toolNameMatches(r.tool, tool) && argMatches(r, tool, arg)) return { allowed: true, rule: r }
  }
  return { allowed: false, reason: `not in the allow list (strict profile): ${tool}${arg ? `(${arg.slice(0, 80)})` : ''}` }
}

export function formatRule(r: PermissionRule): string {
  return r.arg === null ? r.tool : `${r.tool}(${r.arg})`
}
