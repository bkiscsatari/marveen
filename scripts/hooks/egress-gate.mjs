#!/usr/bin/env node
// PreToolUse hook: WebFetch egress allowlist enforcement.
//
// Any WebFetch call from the main agent must target a known, legitimate API
// endpoint. Arbitrary web content (RSS feeds, docs, news pages, public APIs
// not in the allowlist) MUST go through the quarantine-reader sub-agent
// instead, so the fetched content is quarantined, wrapped, and never executed
// as instructions in the main agent's context.
//
// Two-tier allowlist:
//   1. Built-in (ALLOWED_PREFIXES): hard-coded, always enforced.
//   2. Runtime (store/egress-allowlist.json): operator-managed, loaded on each
//      invocation. Shape: { "domains": ["example.com"], "prefixes": ["https://host/path/"] }
//      Both keys are optional. Missing file or malformed JSON -> treated as empty
//      lists (FAIL-OPEN on the file, FAIL-SAFE on the decision: the built-in list
//      still guards; no extra URLs are allowed merely because the file is missing).
//
// When a URL is not on either allowlist:
//   - The tool call is HARD-BLOCKED (decision: deny).
//   - The blocked call is appended to EGRESS_BLOCK_LOG for operator review.
//   - The operator can approve the URL/domain: add it to store/egress-allowlist.json,
//     then re-run the WebFetch. No restart required for THIS hook (it re-reads
//     the JSON on every invocation).
//   - GRANT LATENCY for the quarantine-reader (EGRESSRENDER824): the reader's
//     own prompt-level list is a RENDERED copy of this JSON, refreshed by a
//     file-watcher within ~5s of a JSON change and read at the reader's next
//     SPAWN. A denial from the reader's prompt copy produces NO line in the
//     block log below (it rejects without a network call) -- if a freshly
//     granted domain is still refused, wait a few seconds and spawn a new
//     reader; a session restart is NOT needed.
//
// The log is separate from the main Marveen log so operators can grep it
// independently: `tail -f store/egress-blocked.log`
//
// Scope: this guard covers the Claude Code WebFetch tool only. It does NOT
// intercept WebSearch, curl/Bash network calls, or MCP-server outbound
// requests. Those channels are out of scope for this hook mechanism and require
// separate controls if needed.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Derive repo root from this script's location (scripts/hooks/egress-gate.mjs).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EGRESS_BLOCK_LOG = join(REPO_ROOT, 'store', 'egress-blocked.log')
const RUNTIME_ALLOWLIST_PATH = join(REPO_ROOT, 'store', 'egress-allowlist.json')

// Dashboard port: env WEB_PORT, else the install .env, else the 3420 default.
// A fixed 3420 in the allowlist below blocked the agent's own dashboard as soon
// as the install moved to another port.
// SECURITY: the value is interpolated into an allowlist PREFIX (`http://localhost:${PORT}/`), so it
// must be digits ONLY. An unvalidated value containing `@` turns the whole `localhost:<value>` part
// into a URL userinfo section -- `http://localhost:3420@evil.com/` resolves to host evil.com, which
// would put an attacker-chosen host on the built-in allowlist and defeat the egress gate entirely.
// Anything that is not 1-5 digits is rejected and falls back to the default port.
const isValidPort = (v) => /^\d{1,5}$/.test(v)
const DASHBOARD_PORT = (() => {
  const fromEnv = process.env['WEB_PORT']
  if (fromEnv && isValidPort(fromEnv)) return fromEnv
  try {
    const m = readFileSync(join(REPO_ROOT, '.env'), 'utf-8').match(/^WEB_PORT=(.*)$/m)
    const v = m?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (v && isValidPort(v)) return v
  } catch { /* no .env: fall through to the default */ }
  return '3420'
})()

// Built-in allowlist: URL prefixes the main agent may call directly via WebFetch.
// Anything not on this list (or the runtime allowlist) must go through the
// quarantine-reader sub-agent. Keep sorted and documented so additions are
// intentional, not accidental.
const ALLOWED_PREFIXES = [
  // GitHub REST API
  'https://api.github.com/',
  // Google OAuth token endpoint
  'https://oauth2.googleapis.com/',
  // Google APIs (Calendar, Gmail, Drive, etc.)
  'https://www.googleapis.com/',
  'https://gmail.googleapis.com/',
  'https://calendar.googleapis.com/',
  // Telegram Bot API
  'https://api.telegram.org/',
  // Slack Web API
  'https://slack.com/api/',
  // Discord REST API
  'https://discord.com/api/',
  // Ollama (local LLM server) -- localhost and loopback
  'http://localhost:11434/',
  'http://127.0.0.1:11434/',
  // Marveen dashboard API (local). The port follows WEB_PORT: a fixed 3420 here
  // blocked the agent's own dashboard once the install moved to another port.
  `http://localhost:${DASHBOARD_PORT}/`,
  `http://127.0.0.1:${DASHBOARD_PORT}/`,
]

// The quarantine tier.
//
// The block message tells the caller to fetch through the quarantine-reader
// sub-agent -- and until now this same hook blocked that sub-agent too, so the
// escape hatch the gate prescribed was one the gate closed (kanban #224).
//
// A sub-agent's PreToolUse payload carries two fields a main agent's does not:
// `agent_id` and `agent_type` (measured 2026-08-03, both key sets recorded in
// store/egress-blocked.log). `agent_type` is what separates the tiers.
//
// FAIL-CLOSED: only an exact `agent_type` match opens this tier. A missing,
// empty, unknown or misspelled value is treated as a main agent, i.e. blocked.
// A mistake here can only deny a fetch, never grant one.
//
// The domain list mirrors the one in the sub-agent's own definition
// (templates/sub-agents/quarantine-reader.md). That copy is a promise the
// sub-agent makes to itself in its prompt; this one is enforcement. Keep them
// in step -- and when they disagree, this file is the one that decides.
const QUARANTINE_AGENT_TYPE = 'quarantine-reader'

// `path` (optional) narrows a domain to the URLs the sub-agent's definition
// actually promises. Reddit is the reason it exists: the definition allows RSS
// feeds only, and hostname matching alone would hand over the entire site.
const QUARANTINE_DOMAINS = [
  { domain: 'status.anthropic.com' },
  { domain: 'status.claude.com' },
  { domain: 'feeds.feedburner.com' },
  { domain: 'rss.arxiv.org' },
  { domain: 'export.arxiv.org' },
  { domain: 'hnrss.org' },
  { domain: 'feeds.arstechnica.com' },
  { domain: 'techcrunch.com' },
  { domain: 'feeds.reuters.com' },
  { domain: 'feeds.bbci.co.uk' },
  { domain: 'www.reddit.com', path: (p) => p.endsWith('.rss') },
]

function matchesQuarantineDomain(url, extraDomains = []) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const hostMatches = (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
  for (const entry of QUARANTINE_DOMAINS) {
    if (!hostMatches(entry.domain)) continue
    if (entry.path && !entry.path(parsed.pathname)) return false
    return true
  }
  // Operator additions carry no path rule: an entry someone typed into the
  // store file is a deliberate act, and second-guessing its shape here would
  // only make the file's behaviour harder to predict.
  return extraDomains.some(hostMatches)
}

// OPEN QUARANTINE MODE (operator decision, 2026-09-18).
//
// With `"quarantine_open": true` in store/egress-allowlist.json the
// quarantine-reader may fetch ANY public host instead of a curated list. The
// owner's reasoning: every request so far was approved anyway, and the
// per-domain round trip stalled research mid-task. What the tier still
// protects is unchanged and is the part that matters: fetched content comes
// back as DATA through the reader, never as instructions in an agent's
// context, and the MAIN agent's own WebFetch stays on the curated list.
//
// Open mode is NOT open to everything. Three classes stay blocked, because
// they are the ways an open fetch turns into an outbound channel or an
// internal probe:
//   1. Non-public hosts: loopback, RFC1918, link-local (169.254.169.254 is the
//      cloud metadata endpoint), internal TLDs, and wildcard-DNS names that
//      encode an inward address (127.0.0.1.nip.io).
//   2. Exfiltration sinks: paste services, request bins and webhook catchers,
//      URL shorteners, anonymous file drops, bot APIs. A GET to one of these
//      carries whatever is in the URL out of the house.
//   3. Non-http(s) schemes and non-standard ports.
// The denylist is baked in here, not only in the JSON, so an operator editing
// the file cannot lose it by accident; `quarantine_denylist` in the JSON adds
// to it and never subtracts.
const OPEN_MODE_DENY = [
  // paste / text drops
  'pastebin.com', 'paste.ee', 'hastebin.com', 'ghostbin.com', 'termbin.com', '0x0.st', 'dpaste.org', 'rentry.co',
  // request bins, webhook catchers, tunnels
  'webhook.site', 'requestbin.com', 'pipedream.net', 'requestcatcher.com', 'beeceptor.com',
  'ngrok.io', 'ngrok-free.app', 'loca.lt', 'serveo.net', 'trycloudflare.com',
  // url shorteners (a shortener hides the real destination from this gate)
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'shorturl.at',
  // anonymous file drops
  'transfer.sh', 'file.io', 'anonfiles.com', 'gofile.io', 'catbox.moe', 'tmpfiles.org',
  // bot / message APIs and form endpoints: a plain GET posts a message or a row
  'api.telegram.org', 'discord.com', 'discordapp.com', 'discord.gg', 'slack.com',
  'script.google.com', 'docs.google.com', 'forms.gle', 'google-analytics.com', 'analytics.google.com',
  // more request bins and tunnels (Argus F1)
  'smee.io', 'postb.in', 'typedwebhook.tools', 'ngrok.app', 'ngrok.dev', 'localtunnel.me',
  // wildcard-DNS services: the name check covers the encoded forms, this covers the rest
  'nip.io', 'sslip.io', 'traefik.me', 'localtest.me', 'lvh.me', 'vcap.me',
]

// The denylist NAMES a set; open mode faces an unbounded one. Argus F1 says it
// plainly and it belongs here, not in a review file: in open mode ANY
// attacker-owned public host is an exfiltration channel, so this list buys
// hygiene against the obvious sinks, not a guarantee. The guarantee comes from
// the reader's isolation (content is data) and from the audit log.

// Host shape check, mirroring isPublicFetchHost() in src/web/agent-scaffold.ts.
// Duplicated on purpose: this hook is a standalone .mjs with no import path
// into the TypeScript build, and a gate that depends on a build artifact is a
// gate that can be missing. When the two disagree, THIS one decides.
// Is this IPv4 (as four numbers) one we must never reach from the reader?
// Loopback, "this network", RFC1918, CGNAT, link-local (169.254.169.254 is the
// cloud metadata endpoint), and the IPv4 broadcast.
export function isInwardIPv4(a, b, c, d) {
  const n = [a, b, c, d].map((x) => Number(x))
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false
  if (n[0] === 127 || n[0] === 10 || n[0] === 0) return true
  if (n[0] === 192 && n[1] === 168) return true
  if (n[0] === 169 && n[1] === 254) return true
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true
  if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true   // CGNAT (Argus F4)
  if (n[0] === 255 && n[1] === 255 && n[2] === 255 && n[3] === 255) return true
  return false
}

// ONE normaliser, used by every open-mode check (Argus UB1, 2026-09-18).
// The first version normalised in the SHAPE check and compared the RAW hostname
// against the denylist, so "pastebin.com." passed both: the shape check saw
// "pastebin.com" (public, fine) and the denylist saw a string that matched no
// entry. Six sinks went from BLOCK to ALLOW, with an ALLOWED line in the log.
// The lesson is the rule now: normalise once, at the edge, and let every check
// downstream see the same string.
export function normalizeHost(hostname) {
  return String(hostname ?? '').trim().toLowerCase().replace(/\.+$/, '')
}

// A DNS LABEL can encode an address in more ways than the dotted quad.
// Measured by Argus on 2026-09-18, every one of these resolved inward while the
// first version of this check said "public": 7f000001.nip.io -> 127.0.0.1,
// a9fea9fe.nip.io -> 169.254.169.254 (the metadata endpoint the comment above
// names), app-127-0-0-1.nip.io -> 127.0.0.1, 100-64-0-1.nip.io -> CGNAT.
// So: 8 hex digits is a 32-bit address; a dashed quad counts even as a
// SUBSTRING of a longer label; a long run of digits is a decimal address.
export function labelEncodesInwardAddress(label) {
  const l = String(label ?? '').toLowerCase()
  if (!l) return false
  // 8 hex digits as a DASH-DELIMITED piece of the label: 7f000001,
  // app-7f000001, 7f000001-app. Not embedded in a longer run of hex, because
  // Argus measured what the wildcard-DNS services actually serve:
  // deadbeef7f000001.nip.io is NXDOMAIN, while app-7f000001.nip.io resolves to
  // 127.0.0.1. Scanning every overlapping window blocked 27% of random 32-char
  // hex labels -- CDN names like dqwjwmk7f000001.cloudfront.net -- for a form
  // that cannot resolve inward anyway. An over-block here would look like a
  // random network error, and nobody would come looking in this file for it.
  for (const m of l.matchAll(/(?:^|-)([0-9a-f]{8})(?=-|$)/g)) {
    const v = parseInt(m[1], 16)
    if (Number.isInteger(v) && isInwardIPv4((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)) return true
  }
  // Dashed quad anywhere, OVERLAPPING: in "1-2-127-0-0-1" a non-overlapping
  // scan eats the digits as 1-2-127-0 and never sees 127-0-0-1.
  const nums = [...l.matchAll(/\d{1,3}/g)]
  for (let i = 0; i + 3 < nums.length; i++) {
    const [a, b, c, d] = nums.slice(i, i + 4).map((m) => m[0])
    // only count it when the four numbers are actually dash-joined
    const from = nums[i].index ?? 0
    const to = (nums[i + 3].index ?? 0) + nums[i + 3][0].length
    if (!/^[\d-]+$/.test(l.slice(from, to))) continue
    if (isInwardIPv4(a, b, c, d)) return true
  }
  // decimal 32-bit form: 2130706433 == 127.0.0.1. A LEADING ZERO is excluded on
  // purpose: "08080808" is the hex form of 8.8.8.8 (public), and reading it as
  // decimal 8080808 turns it into 0.123.71.104, which the inward check calls
  // private -- a false block on an ordinary-looking label. A real decimal
  // encoding never carries a leading zero. (Caught by the test above.)
  if (/^[1-9]\d{7,9}$/.test(l)) {
    const v = Number(l)
    if (Number.isInteger(v) && v >= 0 && v <= 4294967295) {
      if (isInwardIPv4((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)) return true
    }
  }
  return false
}

// Host SHAPE check. It rejects what a name reveals about itself; what a name
// RESOLVES to is a separate question, answered by resolvesInward() below --
// this one cannot see an A record pointing at 127.0.0.1 (Argus B2).
export function isPublicOpenHost(hostname) {
  const host = normalizeHost(hostname)
  if (!host || host.length > 253) return false
  if (host.startsWith('[') || host.includes(':')) return false   // IPv6 literal / userinfo leftovers
  if (/[^a-z0-9.-]/.test(host)) return false
  if (host.startsWith('.')) return false
  if (/^\d+$/.test(host)) return false                            // decimal IPv4 literal (2130706433)
  if (/^0x[0-9a-f]+$/.test(host)) return false                    // hex IPv4 literal
  if (/^\d+(\.\d+)*$/.test(host)) return false                    // dotted or octal IPv4 literal
  const labels = host.split('.')
  if (labels.length < 2) return false                             // single label: localhost and friends
  if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false
  const INTERNAL_SUFFIX = ['local', 'internal', 'localdomain', 'lan', 'intranet', 'home', 'arpa', 'test',
    'invalid', 'localhost', 'svc', 'cluster', 'corp', 'priv', 'private', 'domain']
  if (INTERNAL_SUFFIX.includes(labels[labels.length - 1])) return false
  // Wildcard-DNS services encode the address in the NAME: nip.io, sslip.io,
  // traefik.me and any clone. Checking the encoding beats listing the services.
  if (labels.some((l) => labelEncodesInwardAddress(l))) return false
  for (let i = 0; i + 3 < labels.length; i++) {
    if (isInwardIPv4(labels[i], labels[i + 1], labels[i + 2], labels[i + 3])) return false
  }
  return true
}

// Does this name RESOLVE inward? (Argus B2: the shape check reads the name, and
// localtest.me / lvh.me / any attacker-owned domain can simply have an A record
// of 127.0.0.1 or 169.254.169.254. A name list cannot close that class; the
// list is infinite.)
//
// RESIDUAL RISK, stated rather than hidden: this resolves at GATE time and the
// fetch resolves again, so a DNS rebind between the two is not covered. It
// raises the bar from "type a name" to "run a rebinding server", and the fetch
// still lands in the reader, whose output is data, never instructions.
//
// FAIL-CLOSED on lookup failure: an unresolvable host is refused. A blocked
// legitimate fetch is visible and retryable; an allowed inward one is not.
export async function resolvesInward(hostname) {
  const { lookup } = await import('node:dns/promises')
  let addrs
  try {
    addrs = await lookup(normalizeHost(hostname), { all: true, verbatim: true })
  } catch {
    return { inward: true, reason: 'dns lookup failed' }
  }
  for (const { address, family } of addrs) {
    if (family === 4) {
      const p = String(address).split('.')
      if (isInwardIPv4(p[0], p[1], p[2], p[3])) return { inward: true, reason: `resolves inward (${address})` }
    } else {
      const a = String(address).toLowerCase()
      // IPv4-mapped (::ffff:127.0.0.1) carries the v4 rules with it.
      const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
      if (mapped && isInwardIPv4(mapped[1], mapped[2], mapped[3], mapped[4])) {
        return { inward: true, reason: `resolves inward (${address})` }
      }
      // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address; the
      // embedded one may be inward even though the outer form looks global.
      const embedded = /^(?:64:ff9b::|2002:)([0-9a-f]{1,4}):([0-9a-f]{1,4})/.exec(a)
      if (embedded) {
        const hi = parseInt(embedded[1], 16), lo = parseInt(embedded[2], 16)
        if (isInwardIPv4((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255)) {
          return { inward: true, reason: `resolves inward (${address})` }
        }
      }
      if (a === '::1' || a === '::' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) {
        return { inward: true, reason: `resolves inward (${address})` }
      }
    }
  }
  return { inward: false, reason: '' }
}

// Open-mode verdict for one URL. Exported so the tests can drive it directly.
// Returns { allowed: boolean, reason: string }.
export function openModeDecision(url, extraDeny = []) {
  let parsed
  try {
    parsed = new URL(String(url ?? ''))
  } catch {
    return { allowed: false, reason: 'unparseable url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'scheme not http(s)' }
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { allowed: false, reason: 'non-standard port' }
  }
  const host = normalizeHost(parsed.hostname)
  if (!isPublicOpenHost(host)) return { allowed: false, reason: 'host not public' }
  const deny = [...OPEN_MODE_DENY, ...extraDeny.filter((d) => typeof d === 'string')]
  for (const d of deny) {
    const entry = d.trim().toLowerCase()
    if (!entry) continue
    if (host === entry || host.endsWith('.' + entry)) {
      return { allowed: false, reason: `denylisted host (${entry})` }
    }
  }
  return { allowed: true, reason: 'open quarantine tier' }
}

// Load the runtime allowlist from store/egress-allowlist.json.
// FAIL-OPEN on the file: missing or malformed -> empty lists, NOT an error.
// The caller must still apply the built-in ALLOWED_PREFIXES.
export function loadRuntimeAllowlist() {
  try {
    const raw = readFileSync(RUNTIME_ALLOWLIST_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      domains: Array.isArray(parsed.domains) ? parsed.domains.filter((d) => typeof d === 'string') : [],
      prefixes: Array.isArray(parsed.prefixes) ? parsed.prefixes.filter((p) => typeof p === 'string') : [],
      // Operator-managed extension of the QUARANTINE tier. Reachable ONLY by
      // the quarantine-reader sub-agent -- putting a domain here does not open
      // it to the main agent, which is the whole point of the split.
      quarantineDomains: Array.isArray(parsed.quarantine_domains)
        ? parsed.quarantine_domains.filter((d) => typeof d === 'string')
        : [],
      // Open quarantine mode: any public host for the reader tier. Strictly
      // boolean true -- a string "true", a 1 or a missing key all mean OFF, so
      // a typo in the file cannot silently open the tier.
      quarantineOpen: parsed.quarantine_open === true,
      quarantineDenylist: Array.isArray(parsed.quarantine_denylist)
        ? parsed.quarantine_denylist.filter((d) => typeof d === 'string')
        : [],
    }
  } catch {
    // Missing file or JSON parse error: treat as empty, never propagate.
    return { domains: [], prefixes: [], quarantineDomains: [], quarantineOpen: false, quarantineDenylist: [] }
  }
}

// Pure decision, with the tier that decided it.
//
// `runtimeList` is the decoded store/egress-allowlist.json (or any equivalent
// object) and `agentType` is the payload's `agent_type` -- empty for a main
// agent. Keeping file I/O out of this function makes it fully unit-testable
// without touching the filesystem.
//
// The tier is returned because the quarantine tier is the security-relevant
// exception and its grants are audited: a fetch nobody can see is a hole
// nobody can find.
//
// Domain matching uses URL-parsed hostname ONLY, not string-contains, to prevent
// bypasses like `https://evil.com/?x=docs.anthropic.com` matching the domain
// "docs.anthropic.com" via a simple includes() check.
export function egressDecision(
  toolName,
  toolInput,
  runtimeList = { domains: [], prefixes: [], quarantineDomains: [], quarantineOpen: false, quarantineDenylist: [] },
  agentType = '',
) {
  if (toolName !== 'WebFetch') return { blocked: false, tier: 'not-webfetch' }
  const url = String(toolInput?.url ?? '')
  if (!url) return { blocked: false, tier: 'no-url' }

  // OPEN-MODE DENYLIST RUNS FIRST, for the reader only (measured 2026-09-18
  // while testing this change): the built-in prefixes are checked before the
  // quarantine tier, and two of them -- api.telegram.org and the local
  // dashboard -- are exactly the shape the denylist exists to stop (a GET that
  // sends a message, a GET that reads local state). Without this pre-check the
  // denylist would silently NOT cover them. The main agent is unaffected: it
  // needs both, and its content path is a different question.
  if (String(agentType ?? '') === QUARANTINE_AGENT_TYPE && runtimeList.quarantineOpen === true) {
    const pre = openModeDecision(url, runtimeList.quarantineDenylist ?? [])
    if (!pre.allowed) return { blocked: true, tier: 'quarantine-open-deny', reason: pre.reason }
  }

  // 1. Built-in prefix check (startsWith is correct here: the prefix already
  //    includes the trailing slash so a prefix-extension attack is impossible,
  //    e.g. 'https://api.github.com.evil.com/' does not start with
  //    'https://api.github.com/').
  if (ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) return { blocked: false, tier: 'builtin' }

  // 2. Runtime prefix check.
  const rtPrefixes = runtimeList.prefixes ?? []
  if (rtPrefixes.some((p) => url.startsWith(p))) return { blocked: false, tier: 'runtime-prefix' }

  // 3. Runtime domain check: parse the URL to extract a verified hostname.
  //    URL parsing fails on non-URLs -> block (fail-safe).
  const rtDomains = runtimeList.domains ?? []
  if (rtDomains.length > 0) {
    let hostname
    try {
      hostname = new URL(url).hostname
    } catch {
      // Unparseable URL: block, don't throw.
      return { blocked: true, tier: 'unparseable' }
    }
    // Match exact hostname OR any subdomain (host.endsWith('.' + domain)).
    if (rtDomains.some((d) => hostname === d || hostname.endsWith('.' + d))) return { blocked: false, tier: 'runtime-domain' }
  }

  // 4. Quarantine tier -- the ONLY tier a main agent cannot reach. Exact
  //    agent_type match required (fail-closed: anything else falls through to
  //    the block below).
  if (String(agentType ?? '') === QUARANTINE_AGENT_TYPE) {
    if (matchesQuarantineDomain(url, runtimeList.quarantineDomains ?? [])) {
      return { blocked: false, tier: 'quarantine' }
    }
    // Open mode: the curated list no longer decides, but the denylist and the
    // public-host check still do. A refusal here is logged with its reason, so
    // "open" never means "unobservable".
    if (runtimeList.quarantineOpen === true) {
      const verdict = openModeDecision(url, runtimeList.quarantineDenylist ?? [])
      if (verdict.allowed) return { blocked: false, tier: 'quarantine-open' }
      return { blocked: true, tier: 'quarantine-open-deny', reason: verdict.reason }
    }
  }

  return { blocked: true, tier: 'none' }
}

// Back-compatible boolean form.
export function isEgressBlocked(toolName, toolInput, runtimeList, agentType) {
  return egressDecision(toolName, toolInput, runtimeList, agentType).blocked
}

// The payload's top-level FIELD NAMES, sorted -- never a value.
//
// This exists to answer one open question with data instead of a guess: does
// the PreToolUse payload carry anything that identifies the CALLER? The gate
// decides on the URL alone, so a main agent and a quarantine-reader sub-agent
// are indistinguishable to it, and the sub-agent is the escape hatch the block
// message itself prescribes -- which is why the RSS path is currently dead
// (kanban #224). A caller-aware tier can only be built on a field that is
// verified to exist; building it on an assumed one would produce a guard that
// looks like it protects and does not.
//
// Keys only, by construction: a value could carry a url, a prompt, or a
// secret, and this log is read casually. Nested objects contribute nothing but
// their own key.
export function payloadKeySignature(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  return Object.keys(payload).sort().join(',')
}

// `agentType` IS logged by value, unlike everything else in the payload. It is
// an agent-type name from a fixed set -- not content, not a url, not a secret
// -- and without it a denied sub-agent call cannot be told apart from a denied
// main-agent one, which is exactly the distinction this log now exists to make.
// B3/B4 (Argus, 2026-09-18, both reproduced): the decision is made on the
// PARSED url, the log wrote the RAW one. The WHATWG parser drops a newline, a
// log file does not -- so a single WebFetch could append a complete, forged,
// attacker-timestamped ALLOWED_QUARANTINE_OPEN line. And in open mode the full
// query string of EVERY fetch landed in the file: tokens, presigned URLs,
// session ids, in a file meant for casual reading.
//
// So the log gets origin + pathname, plus the query KEY NAMES only -- the same
// rule payloadKeySignature already applies to the payload: a name is
// descriptive, a value can be a secret. Anything unparseable is percent-escaped
// rather than trusted.
export function logSafeUrl(raw) {
  const escape = (v) => String(v).replace(/[\r\n\t"\\]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0'))
  let u
  try {
    u = new URL(String(raw ?? ''))
  } catch {
    return { url: escape(String(raw ?? '').slice(0, 300)), queryKeys: '' }
  }
  // A key name is attacker-chosen too: escape the separators that would make
  // one key look like two log FIELDS (space, '='), and cap the count so a URL
  // with 500 parameters cannot push the rest of the line off the screen.
  // '+' is escaped as well, so the "+N" truncation marker below cannot be
  // confused with a query key that happens to be called "+13" (Argus).
  const keyEscape = (v) => escape(v).replace(/[ =+]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0'))
  const all = [...new Set([...u.searchParams.keys()])]
  const shown = all.slice(0, 12).map(keyEscape)
  if (all.length > shown.length) shown.push(`+${all.length - shown.length}`)
  return { url: escape(u.origin + u.pathname), queryKeys: shown.join(',') }
}

function logLine(kind, url, detail, keys = '', agentType = '') {
  try {
    mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
    const ts = new Date().toISOString()
    const keyPart = keys ? ` payload_keys="${String(keys).replace(/[^A-Za-z0-9_,.-]/g, '')}"` : ''
    const safe = logSafeUrl(url)
    const queryPart = safe.queryKeys ? ` query_keys="${safe.queryKeys}"` : ''
    // `detail` is built by this file from a fixed set of reasons, never from
    // fetched content; the url and the agent type are the caller-influenced
    // parts and both are escaped above.
    const safeDetail = String(detail).replace(/[\r\n]/g, ' ')
    const safeAgent = String(agentType).replace(/[^A-Za-z0-9_-]/g, '')
    const agentSafe = safeAgent ? ` agent_type="${safeAgent}"` : ''
    appendFileSync(EGRESS_BLOCK_LOG, `${ts} ${kind} url="${safe.url}"${queryPart} ${safeDetail}${agentSafe}${keyPart}\n`, 'utf-8')
  } catch {
    // Never let log failure cascade into blocking the agent process itself.
  }
}

const BLOCK_MESSAGE =
  'Egress TILTOTT (egress-gate hook). Ez az URL nem szerepel a fő ágens WebFetch ' +
  'engedélylistáján. Külső web-tartalom (RSS, dokumentáció, cikkek, ismeretlen API-k) ' +
  'KIZÁRÓLAG a quarantine-reader sub-ágensen keresztül kérhető le: ' +
  'Agent({ subagent_type: "quarantine-reader", prompt: `FETCH {"url":"...","nonce":"..."}` }). ' +
  'A letiltott hívás rögzítve lett a store/egress-blocked.log fájlban. ' +
  'Ha ez a hívás jogos, az operátor jóváhagyhatja: adja hozzá az URL-t vagy domain-t a ' +
  'store/egress-allowlist.json fájlhoz ({ "domains": ["example.com"] } vagy ' +
  '{ "prefixes": ["https://example.com/api/"] }), majd futtassa újra a WebFetch hívást.'

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  // Async because the reader's open path resolves DNS before allowing (see
  // resolvesInward). Any throw inside must still end in a DECISION, never in an
  // unhandled rejection that leaves the tool call hanging -- and for the one
  // path that can throw, that decision is a denial (Argus F7: the first version
  // fell back to allow(), which contradicted the file's own fail-closed
  // doctrine at exactly the tier that has no curated list behind it).
  let readerOpenPath = false
  await (async () => {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never block the agent
  }
  const url = String(payload?.tool_input?.url ?? '')
  const agentType = String(payload?.agent_type ?? '')
  const runtimeList = loadRuntimeAllowlist()
  readerOpenPath = agentType === QUARANTINE_AGENT_TYPE && runtimeList.quarantineOpen === true
  const decision = egressDecision(payload?.tool_name, payload?.tool_input, runtimeList, agentType)
  if (decision.blocked) {
    const reason = decision.tier === 'quarantine-open-deny'
      ? `reason="open quarantine tier refused: ${decision.reason}"`
      : 'reason="not on egress allowlist"'
    logLine('BLOCKED', url, reason, payloadKeySignature(payload), agentType)
    deny(decision.tier === 'quarantine-open-deny'
      ? `Egress TILTOTT: a karanten-olvaso nyitott modban is tiltott celt kert (${decision.reason}). ` +
        'Nem publikus host, nem http(s), nem szabvanyos port, vagy tiltolistas cel (paste-oldal, ' +
        'webhook-gyujto, linkroviditо, fajl-dobozok, bot-API). A hivas rogzitve a store/egress-blocked.log fajlban.'
      : BLOCK_MESSAGE)
  }

  // THE RESOLVED-ADDRESS CHECK IS HOST-SCOPED, NOT TIER-SCOPED (Argus F6).
  // Tying it to the open tier alone made the same URL allowed or denied
  // depending on which list happened to name it: with quarantine_domains:[]
  // "localho.st" was denied (resolves to ::1), and with it listed, allowed.
  // The live file carries ~150 such entries plus their subdomains, all
  // unverified. So while the reader runs in open mode, EVERY allowing tier
  // goes through the same address check -- a name that resolves inward is
  // never reachable from the reader, whatever list it is on.
  // Scope, stated at the top of this file and now honoured here too (Argus N2):
  // this gate covers WebFetch calls that carry a url. Without the guard the
  // address check ran on every tool call the reader makes and denied the ones
  // with no url at all -- it could never grant anything, but the refusal
  // reason would have been nonsense.
  if (readerOpenPath && url && decision.tier !== 'not-webfetch' && decision.tier !== 'no-url') {
    let host = ''
    try { host = new URL(url).hostname } catch { host = '' }
    const verdict = host ? await resolvesInward(host) : { inward: true, reason: 'unparseable host' }
    if (verdict.inward) {
      logLine('BLOCKED', url, `reason="reader refused: ${verdict.reason}"`, payloadKeySignature(payload), agentType)
      deny('Egress TILTOTT: a cel neve publikus, de BELSO cimre mutat (' + verdict.reason + '). ' +
        'A karanten-olvaso nem erhet el loopback, maganhalozati vagy metaadat-cimet. Rogzitve a store/egress-blocked.log fajlban.')
    }
  }

  // Audited, not silent: the quarantine tier is the one grant a main agent
  // cannot obtain, so every use of it leaves a line next to the denials. The
  // other tiers are the ordinary allowlist and stay quiet.
  if (decision.tier === 'quarantine') {
    logLine('ALLOWED_QUARANTINE', url, 'reason="quarantine-reader tier"', '', agentType)
  }
  // Open mode replaces per-domain approval with per-fetch AUDIT: the owner no
  // longer sees the list in advance, so every open-tier fetch must leave a line.
  if (decision.tier === 'quarantine-open') {
    logLine('ALLOWED_QUARANTINE_OPEN', url, 'reason="open quarantine tier"', '', agentType)
  }
  allow()
  })().catch(() => {
    // Fail-closed where the open tier is in play, fail-open elsewhere: a main
    // agent still has the curated list behind it, so a hook crash must not
    // break its ordinary work.
    if (readerOpenPath) {
      deny('Egress TILTOTT: a kapu nem tudott dontest hozni (belso hiba), nyitott modban ez elutasitast jelent.')
    }
    allow()
  })
}
