// The router's target availability after the hardening: real CLI login facts
// (installed AND logged in, minimax subscription included), a quota cool-down
// fed by run outcomes, and a PATH scan that does not block the event loop.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { noteRunOutcome, quotaCoolingDown, isRateLimited, _resetQuotaState } from '../runtime/quota-state.js'
import { binaryOnPath } from '../web/runtime-availability.js'
import { targetAvailability } from '../web/model-routing.js'
import type { RuntimeKind } from '../runtime/types.js'

beforeEach(() => _resetQuotaState())

describe('quota cool-down', () => {
  it('a rate-limit block cools the runtime/provider down; a success clears it', () => {
    expect(isRateLimited({ blocked: true, reason: 'HTTP 429 Too Many Requests' })).toBe(true)
    expect(isRateLimited({ blocked: true, reason: 'auth: not signed in' })).toBe(false)
    noteRunOutcome('minimax-cli', 'minimax', { blocked: true, reason: 'usage limit reached' }, 1_000, 60_000)
    expect(quotaCoolingDown('minimax-cli', 'minimax', 2_000).cooling).toBe(true)
    expect(quotaCoolingDown('minimax-cli', 'minimax', 62_000).cooling).toBe(false)
    noteRunOutcome('minimax-cli', 'minimax', { blocked: true, reason: '429' }, 100_000, 60_000)
    noteRunOutcome('minimax-cli', 'minimax', { blocked: false }, 101_000)
    expect(quotaCoolingDown('minimax-cli', 'minimax', 102_000).cooling).toBe(false)
  })
})

describe('binaryOnPath (no subprocess)', () => {
  it('finds an executable on PATH and ignores a non-executable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marveen-path-'))
    writeFileSync(join(dir, 'mcode'), '#!/bin/sh\n'); chmodSync(join(dir, 'mcode'), 0o755)
    writeFileSync(join(dir, 'codex'), 'x'); chmodSync(join(dir, 'codex'), 0o644)
    expect(binaryOnPath('mcode', { PATH: `/nonexistent:${dir}` })).toBe(true)
    expect(binaryOnPath('codex', { PATH: dir })).toBe(false)
    expect(binaryOnPath('gemini', { PATH: dir })).toBe(false)
  })
})

describe('targetAvailability', () => {
  const all: RuntimeKind[] = ['claude-tmux', 'claude-headless', 'codex-cli', 'gemini-cli', 'native-api', 'minimax-cli']
  const facts = (over: Partial<Record<'minimax' | 'codex' | 'gemini', { installed: boolean; loggedIn: boolean }>> = {}) => () => ({
    minimax: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: false }, gemini: { installed: false, loggedIn: false }, ...over,
  })
  const deps = (o: Record<string, unknown> = {}) => ({ availableRuntimes: all, secretLookup: () => null, fleetOauthToken: 'tok', agentId: 'scout', cliFacts: facts(), quota: () => ({ cooling: false }), ...o })

  it('a subscription minimax target is available with the mcode login (it used to fail the API-key check)', () => {
    expect(targetAvailability({ model: 'minimax-m3', runtime: 'minimax-cli', provider: 'minimax' }, deps()).available).toBe(true)
  })
  it('codex/gemini are no longer "always available": not logged in / not installed say so', () => {
    expect(targetAvailability({ model: 'gpt-5.6-sol', runtime: 'codex-cli', provider: 'openai' }, deps())).toMatchObject({ available: false, reason: 'not_logged_in:codex-cli' })
    expect(targetAvailability({ model: 'gemini-2.5-pro', runtime: 'gemini-cli', provider: 'google' }, deps())).toMatchObject({ available: false, reason: 'not_installed:gemini-cli' })
    // an API key in the vault is enough for an installed CLI
    expect(targetAvailability({ model: 'gpt-5.6-sol', runtime: 'codex-cli', provider: 'openai' }, deps({ secretLookup: (id: string) => (/OPENAI/.test(id) ? 'k' : null) })).available).toBe(true)
  })
  it('a runtime cooling down after a 429 is skipped', () => {
    const d = deps({ quota: (rt: string) => ({ cooling: rt === 'minimax-cli' }) })
    expect(targetAvailability({ model: 'minimax-m3', runtime: 'minimax-cli', provider: 'minimax' }, d)).toMatchObject({ available: false, reason: 'quota_cooldown:minimax-cli/minimax' })
    expect(targetAvailability({ model: 'claude-sonnet-5', runtime: 'claude-headless', provider: 'anthropic' }, d).available).toBe(true)
  })
})
