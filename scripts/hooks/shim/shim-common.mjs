// Shared payload normalisation + hook runner for the Codex and Gemini shims.
//
// The governance scripts read Claude-shaped tool input: WebFetch has
// tool_input.url, Bash has tool_input.command as ONE string. The foreign CLIs
// do not send that shape, and the first shim versions passed their input
// through untouched:
//   - Gemini's web_fetch takes {prompt} with the URL(s) inside the text
//     (gemini-cli 0.60.0: WEB_FETCH_PARAM_PROMPT = "prompt", no url param).
//     egress-gate.mjs saw no url, answered tier "no-url" = ALLOW -- the egress
//     gate was fail-open on real Gemini traffic.
//   - Codex's shell tool may carry the command as an argv array
//     (["bash","-lc","curl ..."]) or as `cmd`; a string-matching gate sees
//     nothing it recognises.
// This module rewrites both into the Claude shape, runs a WebFetch hook once
// per URL (first deny wins, no URL = deny), and applies the fail-closed rule
// for the security gates: a crash or unexpected exit of one of them is a block.

import { spawnSync } from 'node:child_process'

export const FAIL_CLOSED_HOOK_RX = /(egress-gate\.mjs|email-send-gate\.mjs|email-approval-gate\.py|gmail-draft-send-gate\.py|outgoing-copy-gate\.py|self-pace-gate\.mjs)/

export function extractUrls(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const u = m[0].replace(/[.,;:!?]+$/, '')
    if (!out.includes(u)) out.push(u)
  }
  return out
}

function shQuote(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** Tool input in the Claude shape the governance scripts expect. */
export function normalizeToolInput(claudeTool, input) {
  if (!input || typeof input !== 'object') return input
  const out = { ...input }
  if (claudeTool === 'Bash') {
    if (Array.isArray(out.command)) {
      const argv = out.command.map(String)
      // ["bash","-lc","script"] / ["sh","-c","script"]: the script is the command.
      if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) out.command = argv.slice(2).join(' ')
      else out.command = argv.map(shQuote).join(' ')
    } else if (typeof out.command !== 'string' && typeof out.cmd === 'string') {
      out.command = out.cmd
    }
  }
  return out
}

/**
 * Run one Claude-dialect hook command with a payload. For WebFetch without a
 * url (Gemini), the hook runs once per URL found in the prompt.
 * Returns {status, stdout, stderr}; status 2 = block.
 */
export function runClaudeHook(command, payload, env) {
  const failClosed = FAIL_CLOSED_HOOK_RX.test(command)
  const once = (p) => {
    const res = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(p), encoding: 'utf-8', env, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 })
    if (res.error) return { status: 2, stdout: '', stderr: `${res.stderr ?? ''}shim: failed to run hook: ${res.error.message}\n` }
    let status = res.status ?? 2 // killed by a signal -> block
    if (failClosed && status !== 0 && status !== 2) {
      return { status: 2, stdout: res.stdout ?? '', stderr: `${res.stderr ?? ''}shim: security gate exited ${status} -- blocking (fail closed)\n` }
    }
    return { status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }
  const input = payload && typeof payload === 'object' ? payload.tool_input : undefined
  if (payload && payload.tool_name === 'WebFetch' && input && typeof input === 'object' && !input.url) {
    const urls = extractUrls(input.prompt)
    if (!urls.length) {
      if (!failClosed) return once(payload)
      return { status: 2, stdout: '', stderr: 'shim: WebFetch without a URL the egress gate can judge -- blocking (fail closed)\n' }
    }
    let last = { status: 0, stdout: '', stderr: '' }
    for (const url of urls) {
      last = once({ ...payload, tool_input: { ...input, url } })
      if (last.status === 2 || /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"(deny|block)"/.test(last.stdout)) return last
    }
    return last
  }
  return once(payload)
}

/** Claude reply stdout says deny? */
export function stdoutDenies(out) {
  return /"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"(deny|block)"/.test(String(out ?? ''))
}
