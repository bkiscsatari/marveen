// The open reader posture ("quarantine_reader_posture": "denylist") after the
// 2026-09-22 hardening: the name-based bypasses that the upstream v1.39 rules
// let through, the restored exfiltration-sink list, and the resolved-address
// check (fail-closed on lookup failure).
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { egressDecision, isQuarantineDenied, normalizeHost, labelEncodesInwardAddress, resolvesInward } from '../../scripts/hooks/egress-gate.mjs'

const QUARANTINE = 'quarantine-reader'
const EMPTY = { domains: [], prefixes: [], quarantineDomains: [] }
const OPEN = { ...EMPTY, quarantinePosture: 'denylist' }

describe('reader posture: name-level bypasses are closed', () => {
  it('refuses a trailing-dot internal host', () => {
    for (const url of ['http://localhost./', 'http://localhost../x', 'http://printer.local./', 'http://box.internal./']) {
      expect(egressDecision('WebFetch', { url }, OPEN, QUARANTINE).blocked).toBe(true)
    }
  })

  it('refuses wildcard-DNS names that encode an inward address', () => {
    for (const url of [
      'http://127.0.0.1.nip.io/',
      'http://app-127-0-0-1.nip.io/',
      'http://7f000001.nip.io/',
      'http://a9fea9fe.sslip.io/latest/meta-data/',
      'http://10.0.0.5.sslip.io/',
      'http://100-64-0-1.nip.io/',
    ]) {
      expect(egressDecision('WebFetch', { url }, OPEN, QUARANTINE).blocked).toBe(true)
    }
  })

  it('refuses the exfiltration sinks, with or without a trailing dot, and on subdomains', () => {
    for (const url of [
      'https://pastebin.com/raw/x',
      'https://pastebin.com./raw/x',
      'https://webhook.site/abc',
      'https://bit.ly/abc',
      'https://x.ngrok.io/',
      'https://api.telegram.org/botX/sendMessage?text=secret',
    ]) {
      expect(egressDecision('WebFetch', { url }, OPEN, QUARANTINE).blocked).toBe(true)
    }
  })

  it('refuses non-standard ports on the open path', () => {
    expect(isQuarantineDenied('https://example.org:8443/')).toBe(true)
    expect(isQuarantineDenied('https://example.org:443/')).toBe(false)
  })

  it('adds the operator denylist on top, never subtracting the built-in one', () => {
    expect(isQuarantineDenied('https://news.example.org/a', ['example.org'])).toBe(true)
    expect(isQuarantineDenied('https://pastebin.com/', [])).toBe(true)
    const list = { ...OPEN, quarantineDenylist: ['example.org'] }
    expect(egressDecision('WebFetch', { url: 'https://news.example.org/a' }, list, QUARANTINE).blocked).toBe(true)
  })

  it('keeps ordinary public sites and CDN-looking names reachable', () => {
    for (const url of [
      'https://www.theguardian.com/world',
      'https://dqwjwmk7f000001.cloudfront.net/x.js',
      'https://08080808.example.com/',
      'https://evil.example/feed',
    ]) {
      expect(egressDecision('WebFetch', { url }, OPEN, QUARANTINE).blocked).toBe(false)
    }
  })

  it('leaves the main agent and the default posture exactly as before', () => {
    expect(egressDecision('WebFetch', { url: 'http://localhost:3420/api/x' }, OPEN, '').blocked).toBe(false)
    expect(egressDecision('WebFetch', { url: 'https://pastebin.com/raw/x' }, EMPTY, QUARANTINE).blocked).toBe(true)
  })
})

describe('helpers', () => {
  it('normalizes once: lowercase, trailing dots off', () => {
    expect(normalizeHost('PasteBin.COM..')).toBe('pastebin.com')
  })

  it('reads the encoded forms, not every hex-looking run', () => {
    expect(labelEncodesInwardAddress('7f000001')).toBe(true)
    expect(labelEncodesInwardAddress('2130706433')).toBe(true)
    expect(labelEncodesInwardAddress('deadbeef7f000001')).toBe(false)
    expect(labelEncodesInwardAddress('08080808')).toBe(false)
  })
})

describe('resolved-address check', () => {
  const fake = (addrs: Array<{ address: string; family: number }> | Error) =>
    async () => { if (addrs instanceof Error) throw addrs; return addrs }

  it('refuses a public name with an inward A/AAAA record', async () => {
    expect((await resolvesInward('localtest.me', fake([{ address: '127.0.0.1', family: 4 }]))).inward).toBe(true)
    expect((await resolvesInward('x.example', fake([{ address: '::ffff:10.0.0.1', family: 6 }]))).inward).toBe(true)
    expect((await resolvesInward('x.example', fake([{ address: 'fd00::1', family: 6 }]))).inward).toBe(true)
    expect((await resolvesInward('x.example', fake([{ address: '64:ff9b::a9fe:a9fe', family: 6 }]))).inward).toBe(true)
  })

  it('fails closed when the name does not resolve', async () => {
    const v = await resolvesInward('nope.example', fake(new Error('ENOTFOUND')))
    expect(v.inward).toBe(true)
    expect(v.reason).toMatch(/lookup failed/)
  })

  it('lets a public address through', async () => {
    expect((await resolvesInward('example.org', fake([{ address: '93.184.216.34', family: 4 }]))).inward).toBe(false)
  })
})
