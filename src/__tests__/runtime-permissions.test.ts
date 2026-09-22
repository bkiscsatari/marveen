import { describe, it, expect } from 'vitest'
import { parsePermissionRule, globToRegExp, buildPermissionSet, checkPermission, expandPlaceholders } from '../runtime/permissions.js'

const vars = { AGENT_DIR: '/home/b/marveen/agents/argus', HOME: '/home/b' }

describe('parsePermissionRule', () => {
  it('parses tool(arg), bare tools and wildcards', () => {
    expect(parsePermissionRule('Read(/x/**)')).toEqual({ tool: 'Read', arg: '/x/**' })
    expect(parsePermissionRule('Bash(curl -X POST:*)')).toEqual({ tool: 'Bash', arg: 'curl -X POST:*' })
    expect(parsePermissionRule('ScheduleWakeup')).toEqual({ tool: 'ScheduleWakeup', arg: null })
    expect(parsePermissionRule('mcp__claude_ai_Supabase__*')).toEqual({ tool: 'mcp__claude_ai_Supabase__*', arg: null })
    expect(parsePermissionRule('')).toBeNull()
  })
  it('expands template placeholders', () => {
    expect(expandPlaceholders('Read(${AGENT_DIR}/**)', vars)).toBe('Read(/home/b/marveen/agents/argus/**)')
  })
})

describe('globToRegExp', () => {
  it('** spans segments, * stays within one', () => {
    expect(globToRegExp('/a/**').test('/a/b/c.txt')).toBe(true)
    expect(globToRegExp('/a/**').test('/a')).toBe(false)
    expect(globToRegExp('**/.env').test('/x/y/.env')).toBe(true)
    expect(globToRegExp('/a/*.md').test('/a/b.md')).toBe(true)
    expect(globToRegExp('/a/*.md').test('/a/b/c.md')).toBe(false)
  })
})

describe('checkPermission -- researcher profile semantics', () => {
  const set = buildPermissionSet({
    allow: ['Read(${AGENT_DIR}/**)', 'Write(${AGENT_DIR}/**)', 'Read(${HOME}/Downloads/**)', 'Bash(ls:*)', 'Bash(cat:*)', 'WebFetch(*)'],
    deny: ['Read(${HOME}/.ssh/**)', 'Read(**/.env)', 'Bash(sudo:*)', 'Bash(rm:*)', 'Bash(curl -X POST:*)', 'ScheduleWakeup'],
  }, 'strict', vars)
  it('allow-listed paths and commands pass', () => {
    expect(checkPermission(set, 'Read', '/home/b/marveen/agents/argus/reports/x.md').allowed).toBe(true)
    expect(checkPermission(set, 'Bash', 'ls -la').allowed).toBe(true)
    expect(checkPermission(set, 'Bash', 'cat foo').allowed).toBe(true)
    expect(checkPermission(set, 'WebFetch', 'https://example.com').allowed).toBe(true)
  })
  it('deny wins over allow, prefix rules need a word boundary', () => {
    expect(checkPermission(set, 'Read', '/home/b/marveen/agents/argus/.env').allowed).toBe(false)
    expect(checkPermission(set, 'Bash', 'rm -rf /').allowed).toBe(false)
    expect(checkPermission(set, 'Bash', 'curl -X POST https://x').allowed).toBe(false)
    expect(checkPermission(set, 'Bash', 'rmdir x').allowed).toBe(false) // strict: rmdir is not allow-listed either
    expect(checkPermission(set, 'ScheduleWakeup', null).allowed).toBe(false)
  })
  it('strict: anything not allow-listed is denied with a reason', () => {
    const d = checkPermission(set, 'Bash', 'git status')
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/not in the allow list/)
    expect(checkPermission(set, 'Read', '/etc/passwd').allowed).toBe(false)
  })
  it('permissive: only the deny list applies', () => {
    const p = buildPermissionSet({ allow: [], deny: ['mcp__claude_ai_Supabase__*', 'Bash(sudo:*)'] }, 'permissive', vars)
    expect(checkPermission(p, 'Bash', 'git status').allowed).toBe(true)
    expect(checkPermission(p, 'mcp__claude_ai_Supabase__execute_sql', null).allowed).toBe(false)
    expect(checkPermission(p, 'Bash', 'sudo ls').allowed).toBe(false)
    expect(checkPermission(p, 'Bash', 'sudoku').allowed).toBe(true)
  })
})
