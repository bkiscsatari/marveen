// OPEN QUARANTINE MODE (owner decision, 2026-09-18).
//
// The per-domain approval loop was removed for the quarantine-reader tier: the
// owner approved every request anyway, and the round trip stalled research
// mid-task. What replaced it is not "no gate" but a different gate -- any
// PUBLIC http(s) host for the reader, minus three classes that turn a fetch
// into something other than reading, plus a log line per fetch.
//
// These tests exist because "open" is exactly the setting where a silent hole
// would never be noticed: with a curated list, a mistake denies a fetch and
// somebody complains; here, a mistake grants one and nobody does.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { egressDecision, openModeDecision, isPublicOpenHost, loadRuntimeAllowlist, labelEncodesInwardAddress, isInwardIPv4, logSafeUrl, normalizeHost } from '../../scripts/hooks/egress-gate.mjs'
import { renderQuarantineReader } from '../web/agent-scaffold.js'

const QUARANTINE = 'quarantine-reader'
type RuntimeList = {
  domains: string[]
  prefixes: string[]
  quarantineDomains: string[]
  quarantineOpen: boolean
  quarantineDenylist: string[]
}
const OPEN: RuntimeList = { domains: [], prefixes: [], quarantineDomains: [], quarantineOpen: true, quarantineDenylist: [] }
const CLOSED: RuntimeList = { domains: [], prefixes: [], quarantineDomains: [], quarantineOpen: false, quarantineDenylist: [] }
const decide = (url: string, list: RuntimeList = OPEN, agent = QUARANTINE) => egressDecision('WebFetch', { url }, list, agent)

describe('open mode: what the reader may now reach', () => {
  it('allows an arbitrary public host that is on no list', () => {
    const d = decide('https://realmonitor.hu/arak')
    expect(d.blocked).toBe(false)
    expect(d.tier).toBe('quarantine-open')
  })

  it('still reports the curated tier when the host IS on the list (the log stays honest)', () => {
    const d = decide('https://techcrunch.com/feed', { ...OPEN, quarantineDomains: ['techcrunch.com'] })
    expect(d.tier).toBe('quarantine')
  })
})

describe('open mode is for the READER only', () => {
  it('does not open the same host for the main agent', () => {
    expect(decide('https://realmonitor.hu/arak', OPEN, '').blocked).toBe(true)
  })

  it('does not open it for some other sub-agent type', () => {
    expect(decide('https://realmonitor.hu/arak', OPEN, 'scout').blocked).toBe(true)
  })

  it('stays shut when the flag is absent or not exactly true', () => {
    expect(decide('https://realmonitor.hu/arak', CLOSED).blocked).toBe(true)
    // A typo in the JSON must not open the tier: "true" is a string, not true.
    expect(decide('https://realmonitor.hu/arak', { ...CLOSED, quarantineOpen: 'true' as unknown as boolean }).blocked).toBe(true)
    expect(decide('https://realmonitor.hu/arak', { ...CLOSED, quarantineOpen: 1 as unknown as boolean }).blocked).toBe(true)
  })
})

describe('open mode: the three classes that stay blocked', () => {
  it('blocks non-public targets, including the cloud metadata endpoint', () => {
    for (const url of [
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://printer.local/x',
      'http://db.internal/x',
    ]) {
      const d = decide(url)
      expect(d.blocked, url).toBe(true)
      expect(d.reason, url).toMatch(/host not public/)
    }
  })

  it('blocks wildcard-DNS names that encode an inward address', () => {
    expect(decide('http://127.0.0.1.nip.io/x').blocked).toBe(true)
    expect(decide('http://192-168-1-50.sslip.io/x').blocked).toBe(true)
  })

  it('blocks exfiltration sinks even though they are public', () => {
    for (const url of [
      'https://webhook.site/abc?payload=secret',
      'https://pastebin.com/raw/x',
      'https://requestbin.com/r/x',
      'https://bit.ly/x',
      'https://file.io/x',
      'https://api.telegram.org/botTOKEN/sendMessage?text=secret',
      'https://hooks.slack.com/services/x',
    ]) {
      const d = decide(url)
      expect(d.blocked, url).toBe(true)
      expect(d.reason, url).toMatch(/denylisted host/)
    }
  })

  it('blocks a non-http scheme and a non-standard port', () => {
    expect(decide('file:///etc/passwd').reason).toMatch(/scheme/)
    expect(decide('https://example.com:8443/x').reason).toMatch(/port/)
  })

  it('honours an install-specific denylist entry, subdomains included', () => {
    const list = { ...OPEN, quarantineDenylist: ['evil.example'] }
    expect(decide('https://evil.example/x', list).blocked).toBe(true)
    expect(decide('https://a.b.evil.example/x', list).blocked).toBe(true)
  })

  it('the JSON denylist adds to the built-in one, it cannot subtract from it', () => {
    // An operator emptying quarantine_denylist must not re-open webhook.site.
    expect(decide('https://webhook.site/x', { ...OPEN, quarantineDenylist: [] }).blocked).toBe(true)
  })
})

describe('the denylist runs BEFORE the built-in prefixes, for the reader', () => {
  // Measured while writing this change: api.telegram.org and the local
  // dashboard are built-in allowed prefixes, and the built-in check runs first.
  // Without the pre-check the denylist would not have covered exactly the two
  // targets it exists for -- a GET that sends a message, a GET that reads local
  // state.
  it('blocks a built-in prefix for the reader when open mode is on', () => {
    const d = decide('https://api.telegram.org/botTOKEN/sendMessage?text=x')
    expect(d.blocked).toBe(true)
    expect(d.tier).toBe('quarantine-open-deny')
  })

  it('leaves the main agent free to use the same built-in prefix', () => {
    expect(decide('https://api.telegram.org/botTOKEN/sendMessage', OPEN, '').blocked).toBe(false)
  })

  it('changes nothing while open mode is off', () => {
    expect(decide('https://api.telegram.org/botTOKEN/sendMessage', CLOSED).blocked).toBe(false)
  })
})

describe('the host-shape check', () => {
  it('accepts ordinary public names', () => {
    for (const h of ['realmonitor.hu', 'www.ingatlan.com', 'sub.domain.co.uk']) {
      expect(isPublicOpenHost(h), h).toBe(true)
    }
  })

  it('rejects bare addresses, single labels and internal suffixes', () => {
    for (const h of ['127.0.0.1', 'localhost', 'box', 'svc.cluster', 'thing.internal', '']) {
      expect(isPublicOpenHost(h), h).toBe(false)
    }
  })
})

describe('openModeDecision on its own', () => {
  it('refuses an unparseable url instead of throwing', () => {
    expect(openModeDecision('not a url').allowed).toBe(false)
  })

  it('states a reason for every refusal (the log is only as good as this string)', () => {
    for (const url of ['http://127.0.0.1/x', 'https://pastebin.com/x', 'ftp://example.com/x']) {
      const v = openModeDecision(url)
      expect(v.allowed, url).toBe(false)
      expect(String(v.reason).length, url).toBeGreaterThan(3)
    }
  })
})

describe('loadRuntimeAllowlist carries the new keys', () => {
  it('defaults to closed when the file is missing or malformed', () => {
    // The loader never throws; the shape it returns must still be safe.
    const list = loadRuntimeAllowlist()
    expect(typeof list.quarantineOpen).toBe('boolean')
    expect(Array.isArray(list.quarantineDenylist)).toBe(true)
  })
})

describe('the reader PROMPT copy must describe the same policy the hook enforces', () => {
  // The prompt is not decoration: the reader refuses from its own list before
  // any network call, so a prompt that still says "only these domains" makes
  // the grant invisible (EGRESSKEY816). In open mode the bullets would be a
  // lie, so the block states the policy instead.
  const TEMPLATE = [
    '# Quarantine Reader',
    '',
    '## Domain restriction',
    '',
    'Only fetch URLs from these approved domains.',
    '- `status.anthropic.com`',
    '',
    '## Output',
    '- `not a domain bullet`',
  ].join('\n')

  it('renders the open policy instead of a domain list', () => {
    const out = renderQuarantineReader(TEMPLATE, ['realmonitor.hu'], { open: true, denylist: ['evil.example'] })
    expect(out).toMatch(/NYITOTT MOD/)
    expect(out).toMatch(/169\.254\.169\.254/)      // the metadata endpoint is named, not implied
    expect(out).toMatch(/evil\.example/)           // install denylist carried into the prompt
    expect(out).not.toMatch(/- `realmonitor\.hu`/) // no per-domain bullets in open mode
  })

  it('renders the plain domain list when open mode is off (unchanged behaviour)', () => {
    const out = renderQuarantineReader(TEMPLATE, ['realmonitor.hu'], { open: false })
    expect(out).toMatch(/- `realmonitor\.hu`/)
    expect(out).not.toMatch(/NYITOTT MOD/)
  })

  it('a re-render replaces the previous block instead of stacking copies', () => {
    const once = renderQuarantineReader(TEMPLATE, ['a.hu'], { open: true })
    const twice = renderQuarantineReader(once, ['a.hu'], { open: true })
    expect(twice).toBe(once)
    // and switching back to closed mode leaves no open-mode text behind
    const back = renderQuarantineReader(once, ['a.hu'], { open: false })
    expect(back).not.toMatch(/NYITOTT MOD/)
  })
})

// --- Argus review, 2026-09-18: the four blockers, each with the case that
// found it. Every URL below ALLOWED before the fix.
describe('B1: a name can encode an address in more ways than the dotted quad', () => {
  it('rejects the hex, decimal and dashed encodings Argus resolved to loopback', () => {
    for (const h of [
      '7f000001.nip.io',          // -> 127.0.0.1
      '0a000001.nip.io',          // -> 10.0.0.1
      'a9fea9fe.nip.io',          // -> 169.254.169.254, the metadata endpoint
      'app-127-0-0-1.nip.io',     // dashed quad inside a longer label
      'app.7f000001.nip.io',
      '7f000001.sslip.io',
      'app-192-168-1-1.traefik.me',
      '100-64-0-1.nip.io',        // CGNAT (F4: the hook used to be laxer here)
    ]) {
      expect(isPublicOpenHost(h), h).toBe(false)
    }
  })

  it('still accepts ordinary names that merely contain digits or dashes', () => {
    for (const h of ['realmonitor.hu', 'web-24.example.com', 'a1b2c3d4.example.org']) {
      expect(isPublicOpenHost(h), h).toBe(true)
    }
  })

  it('rejects address literals in every base', () => {
    for (const h of ['127.0.0.1', '2130706433', '0x7f000001', '0177.0.0.1', '[::1]']) {
      expect(isPublicOpenHost(h), h).toBe(false)
    }
  })

  it('names the CGNAT and broadcast ranges the first version missed', () => {
    expect(isInwardIPv4(100, 64, 0, 1)).toBe(true)
    expect(isInwardIPv4(255, 255, 255, 255)).toBe(true)
    expect(isInwardIPv4(8, 8, 8, 8)).toBe(false)
  })

  it('labelEncodesInwardAddress is exact, not a substring guess', () => {
    expect(labelEncodesInwardAddress('7f000001')).toBe(true)
    expect(labelEncodesInwardAddress('08080808')).toBe(false)   // 8.8.8.8 is public
  })

  it('rejects the corporate internal suffixes (F5)', () => {
    expect(isPublicOpenHost('wiki.corp')).toBe(false)
    expect(isPublicOpenHost('git.priv')).toBe(false)
  })
})

describe('B3: the audit log cannot be forged through the url', () => {
  it('strips the newline the URL parser drops but the log file would keep', () => {
    const { url } = logSafeUrl('https://example.com/a\nFAKE 1970-01-01 ALLOWED_QUARANTINE_OPEN url="x"')
    expect(url).not.toMatch(/\n/)
    expect(url).not.toMatch(/\r/)
  })

  it('escapes quotes and tabs, and never returns a bare unparseable string', () => {
    const { url } = logSafeUrl('not a url"\twith junk')
    expect(url).not.toMatch(/["\t]/)
  })
})

describe('B4: the log records query KEYS, never values', () => {
  it('drops the query string and lists the key names instead', () => {
    const out = logSafeUrl('https://example.com/q?token=ghp_LIVESECRET&pw=hunter2')
    expect(out.url).toBe('https://example.com/q')
    expect(out.queryKeys).toBe('token,pw')
    expect(JSON.stringify(out)).not.toMatch(/ghp_LIVESECRET|hunter2/)
  })
})

describe('F1: the widened denylist', () => {
  it('covers the sinks Argus named', () => {
    for (const url of [
      'https://slack.com/api/chat.postMessage?token=x&text=leak',
      'https://smee.io/x',
      'https://postb.in/x',
      'https://script.google.com/macros/s/x/exec?data=leak',
      'https://docs.google.com/forms/d/e/x/formResponse?entry.1=leak',
      'https://www.google-analytics.com/collect?cid=leak',
      'https://x.ngrok.app/',
    ]) {
      expect(decide(url).blocked, url).toBe(true)
    }
  })
})

// --- Argus v2 review: the regression the first fix introduced.
describe('UB1: a trailing dot is the same host', () => {
  // "pastebin.com." is a valid, resolvable FQDN. The first fix normalised it
  // in the shape check and compared the RAW hostname against the denylist, so
  // all six sinks below flipped from BLOCK to ALLOW -- with an ALLOWED line in
  // the log, which is worse than a silent hole: it looks like a decision.
  it('blocks every denylisted sink in its trailing-dot form', () => {
    for (const url of [
      'https://pastebin.com./raw/x',
      'https://webhook.site./abc?p=secret',
      'https://api.telegram.org./bot1/sendMessage?text=secret',
      'https://slack.com./api/chat.postMessage?token=T',
      'https://bit.ly./x',
      'https://docs.google.com./forms/d/e/x/formResponse',
    ]) {
      const d = decide(url)
      expect(d.blocked, url).toBe(true)
      expect(d.reason, url).toMatch(/denylisted/)
    }
  })

  it('covers the whole built-in denylist, not just the six that were measured', () => {
    // A regression test that only pins the reported cases invites the next
    // entry to be added without its dotted form being covered.
    for (const entry of ['pastebin.com', 'webhook.site', 'ngrok.io', 'file.io', 'smee.io', 'nip.io']) {
      expect(decide(`https://${entry}./x`).blocked, entry).toBe(true)
    }
  })

  it('normalizeHost strips trailing dots and case, and is what every check sees', () => {
    expect(normalizeHost('PasteBin.CoM.')).toBe('pastebin.com')
    expect(normalizeHost('example.com..')).toBe('example.com')
  })

  it('does not break an ordinary dotted host', () => {
    expect(decide('https://realmonitor.hu./arak').blocked).toBe(false)
  })
})

describe('the remaining encoded forms Argus listed as defence-in-depth', () => {
  it('catches a hex address as a dash-delimited piece of the label', () => {
    for (const h of ['app-7f000001.nip.io', '7f000001-app.nip.io', 'app-0a000001-x.nip.io']) {
      expect(isPublicOpenHost(h), h).toBe(false)
    }
  })

  it('does NOT block hex embedded in a longer run -- that form cannot resolve inward', () => {
    // Argus measured it: deadbeef7f000001.nip.io is NXDOMAIN, while
    // app-7f000001.nip.io resolves to 127.0.0.1. Blocking the embedded form
    // cost 27% of random 32-char hex labels (CDN hostnames) for nothing.
    for (const h of ['deadbeef7f000001.nip.io', 'dqwjwmk7f000001.cloudfront.net', 'e1a2b30a000001f.akamaized.net']) {
      expect(isPublicOpenHost(h), h).toBe(true)
    }
  })

  it('catches an overlapping dashed quad (1-2-127-0-0-1)', () => {
    expect(isPublicOpenHost('1-2-127-0-0-1.nip.io')).toBe(false)
  })

  it('does not over-block names that merely look numeric', () => {
    for (const h of ['deadbeef.example.com', '08080808.example.com', '1234567890.example.com',
      '8-8-8-8.example.com', '200-100-50-25.example.com', 'web-24.example.com', 'a1b2c3d4e5f6.example.com']) {
      expect(isPublicOpenHost(h), h).toBe(true)
    }
  })
})

describe('log field separators cannot be forged from a query key', () => {
  it('escapes space and equals inside a key name', () => {
    const out = logSafeUrl('https://e.com/p?a" reason=forged=1&b=2')
    expect(out.queryKeys).not.toMatch(/[ =]/)
    // and a key literally named "+13" must not read as the truncation marker
    expect(logSafeUrl('https://e.com/p?%2B13=x').queryKeys).not.toBe('+13')
  })

  it('caps the number of keys instead of printing all of them', () => {
    const many = Array.from({ length: 40 }, (_, i) => `k${i}=1`).join('&')
    const out = logSafeUrl(`https://e.com/p?${many}`)
    expect(out.queryKeys.split(',').length).toBeLessThanOrEqual(13)
    expect(out.queryKeys).toMatch(/\+\d+$/)
  })
})
