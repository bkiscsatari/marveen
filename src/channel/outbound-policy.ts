// Pure outbound-chat policy, shared by the bridge (access.ts) and the stdio MCP
// server (mcp-server.ts). Kept free of imports so the MCP child process does
// not load the dashboard config just to decide where it may send.

export interface OutboundAccess {
  allowFrom?: Array<string | number>
  groups?: Record<string, unknown>
}

/**
 * Chats the bridge may SEND to: the owner chat, every allowFrom sender (a
 * private chat's id is the user's id) and every allowed group. The outbound
 * MCP server used to accept any chat_id, so a prompt-injected agent could
 * message anyone the bot can reach.
 */
export function allowedOutboundChats(access: OutboundAccess, ownerChat: string | null): Set<string> {
  const out = new Set<string>((access.allowFrom ?? []).map(String))
  for (const g of Object.keys(access.groups ?? {})) out.add(String(g))
  if (ownerChat) out.add(String(ownerChat))
  return out
}
