// MCP servers as AI SDK tools for the native-api runtime (Phase 4).
//
// The agent's .mcp.json (Claude Code project scope) is the single source of
// MCP servers for every runtime; here each server's tools become AI SDK
// dynamicTools named `mcp__<server>__<tool>` -- the exact spelling Claude Code
// uses, so hook matchers such as `.*send_email.*` and ledger-outbound's reply
// matcher keep working. Every call is gated by permissions + PolicyEngine.
//
// Transports: stdio (command/args/env) and streamable HTTP (url). SSE is not
// wired (Marveen's own servers are HTTP; none of the fleet's .mcp.json uses SSE).

import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { logger } from '../../logger.js'
import { gated, type ToolContext } from './tools.js'
import type { McpServerDef } from '../bundle-render.js'

export interface McpConnection {
  name: string
  client: Client
  close: () => Promise<void>
}

export async function connectMcpServer(name: string, def: McpServerDef, opts: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() }): Promise<McpConnection> {
  const client = new Client({ name: 'marveen-native-api', version: '1.0.0' })
  let transport: StdioClientTransport | StreamableHTTPClientTransport
  if (def.url) {
    transport = new StreamableHTTPClientTransport(new URL(def.url), def.headers ? { requestInit: { headers: def.headers } } : undefined)
  } else if (def.command) {
    transport = new StdioClientTransport({ command: def.command, args: def.args ?? [], env: { ...(process.env as Record<string, string>), ...(def.env ?? {}) }, cwd: opts.cwd, stderr: 'pipe' })
  } else {
    throw new Error(`MCP server "${name}": neither command nor url configured`)
  }
  const t = setTimeout(() => { void transport.close().catch(() => { /* best effort */ }) }, opts.timeoutMs ?? 60_000)
  try {
    await client.connect(transport)
  } finally { clearTimeout(t) }
  return { name, client, close: () => client.close() }
}

/** Sanitize a server name for `mcp__<server>__<tool>` ids: every non-alphanumeric
 *  becomes `_` (Claude Code maps `plugin:telegram:telegram` to `plugin_telegram_telegram`). */
export function mcpToolId(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}__${tool}`
}

export async function mcpToolSet(conns: McpConnection[], ctx: ToolContext): Promise<ToolSet> {
  const tools: ToolSet = {}
  for (const c of conns) {
    let listed
    try { listed = await c.client.listTools() } catch (err) { logger.warn({ err, server: c.name }, 'native-api: listTools failed'); continue }
    for (const t of listed.tools) {
      const id = mcpToolId(c.name, t.name)
      const schema = (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema as Record<string, unknown> : { type: 'object', properties: {} }
      tools[id] = dynamicTool({
        description: t.description ?? `${t.name} on MCP server ${c.name}`,
        inputSchema: jsonSchema(schema as never),
        execute: async (input) => gated(ctx, id, null, input, async () => {
          const r = await c.client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> })
          const content = Array.isArray(r.content) ? r.content : []
          const text = content.map((b) => {
            const blk = b as { type?: string; text?: string; mimeType?: string }
            return blk.type === 'text' ? (blk.text ?? '') : `[${blk.type ?? 'block'}${blk.mimeType ? ` ${blk.mimeType}` : ''}]`
          }).join('\n')
          if (r.isError) throw new Error(text || 'MCP tool error')
          return text || JSON.stringify(r.structuredContent ?? {})
        }),
      })
    }
  }
  return tools
}

export async function closeAll(conns: McpConnection[]): Promise<void> {
  await Promise.allSettled(conns.map((c) => c.close()))
}
