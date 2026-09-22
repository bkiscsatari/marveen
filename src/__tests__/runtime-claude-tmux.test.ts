import { describe, it, expect } from 'vitest'
import { classifyPane, claudeTmuxRuntime } from '../runtime/claude-tmux.js'

// Minimal Claude Code footers, shaped like the fixtures in pane-state.test.ts:
// the idle footer, and the same footer with the live-turn ` · esc to interrupt`
// suffix Claude Code appends while a turn runs.
const IDLE_FOOTER = '\n> \n\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n'
const BUSY_FOOTER = '  Thinking…\n> \n\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\n'

describe('claude-tmux adapter: classifyPane maps the TUI to the runtime-neutral state', () => {
  it('null capture -> unknown', () => {
    expect(classifyPane(null)).toBe('unknown')
  })
  it('idle footer -> idle', () => {
    expect(classifyPane(IDLE_FOOTER)).toBe('idle')
  })
  it('a live turn -> busy', () => {
    expect(classifyPane(BUSY_FOOTER)).toBe('busy')
  })
  it('login chrome -> auth', () => {
    expect(classifyPane('Not logged in · Please run /login\n' + IDLE_FOOTER)).toBe('auth')
  })
  it('plan usage-limit banner -> blocked', () => {
    expect(classifyPane("You've hit your usage limit · resets 5:50pm\n" + IDLE_FOOTER)).toBe('blocked')
  })
  it('no Claude footer at all -> unknown (pane is not Claude Code)', () => {
    expect(classifyPane('$ bash\n')).toBe('unknown')
  })
})

describe('claude-tmux adapter: static shape', () => {
  it('advertises the interactive Claude Code capabilities', () => {
    const caps = claudeTmuxRuntime.capabilities({
      id: 'x', dir: '/tmp/x', role: 'sub', model: 'claude-sonnet-5',
      runtime: 'claude-tmux', provider: 'anthropic', authMode: 'subscription', securityProfile: 'default',
    })
    expect(caps).toMatchObject({
      interactive: true, supportsHooks: 'native', supportsMcp: true,
      supportsChannelsPlugin: true, reportsUsage: 'transcript', contextWindow: 200_000,
    })
    expect(claudeTmuxRuntime.kind).toBe('claude-tmux')
  })
})
